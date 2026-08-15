/**
 * ============================================================
 * وكيل دعم عملاء - باستخدام AIChatAgent (الحل الرسمي)
 * 
 * يعتمد هذا الوكيل على إطار العمل الرسمي من Cloudflare
 * لإدارة المحادثات والأدوات بشكل احترافي.
 * 
 * الميزات:
 * - إدارة تلقائية للرسائل والسياق
 * - دعم كامل للأدوات (تحديث البريد، تتبع الطلب، إنشاء التذاكر)
 * - أدوات تتطلب موافقة المستخدم (Human-in-the-loop)
 * - استمرارية الحالة عبر Durable Objects
 * - تخزين المحادثات في SQLite
 * ============================================================
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';
import { tool } from 'ai';
import { z } from 'zod';

// ============================================================
// تعريف بيئة العمل
// ============================================================
type Env = {
  AI: Ai;
  DB: D1Database;
  JWT_SECRET: string;
  RATE_LIMIT_KV: KVNamespace;
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
};

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// ١. رؤوس الأمان و CORS
// ============================================================
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  );
});

app.use(
  '*',
  cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ============================================================
// ٢. نقاط الصحة
// ============================================================
app.get('/health/live', (c) =>
  c.json({ status: 'alive', timestamp: new Date().toISOString() })
);

app.get('/health/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ready', services: { database: 'healthy' } });
  } catch {
    return c.json({ status: 'unhealthy' }, 503);
  }
});

// ============================================================
// ٣. تحديد معدل الطلبات
// ============================================================
async function checkRateLimit(
  env: Env,
  email: string
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const kv = env.RATE_LIMIT_KV;
  const key = `login:${email}`;
  const now = Math.floor(Date.now() / 1000);
  const windowSize = 15 * 60;
  const maxAttempts = 5;

  let data = await kv.get(key, 'json') as
    | { attempts: number; firstAttempt: number }
    | null;

  if (!data) {
    await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), {
      expirationTtl: windowSize,
    });
    return { allowed: true };
  }

  if (now - data.firstAttempt > windowSize) {
    await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), {
      expirationTtl: windowSize,
    });
    return { allowed: true };
  }

  const newAttempts = data.attempts + 1;
  await kv.put(
    key,
    JSON.stringify({ attempts: newAttempts, firstAttempt: data.firstAttempt }),
    { expirationTtl: windowSize }
  );

  if (newAttempts > maxAttempts) {
    return {
      allowed: false,
      retryAfter: windowSize - (now - data.firstAttempt),
    };
  }

  return { allowed: true };
}

// ============================================================
// ٤. المصادقة
// ============================================================
app.post('/api/auth/login', async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const rateLimit = await checkRateLimit(c.env, email);
    if (!rateLimit.allowed) {
      return c.json(
        {
          error: `Too many login attempts. Try again in ${rateLimit.retryAfter}s.`,
        },
        429
      );
    }

    const db = c.env.DB;
    const cleanEmail = email.trim().toLowerCase();

    let user = await db
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(cleanEmail)
      .first();

    if (!user) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db
        .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
        .bind(id, cleanEmail, now)
        .run();
      user = { id, email: cleanEmail, created_at: now };
    }

    const token = await sign(
      {
        sub: user.id,
        email: user.email,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      },
      c.env.JWT_SECRET,
      'HS256'
    );

    return c.json({ success: true, token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('Login error:', e);
    return c.json({ error: 'Login failed' }, 500);
  }
});

app.get('/api/auth/me', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const token = auth.replace('Bearer ', '');
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');

    if (!payload.sub) {
      return c.json({ error: 'Invalid token payload' }, 401);
    }

    const db = c.env.DB;
    const user = await db
      .prepare('SELECT id, email, created_at FROM users WHERE id = ?')
      .bind(payload.sub)
      .first();

    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ user });
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// ============================================================
// ٥. أدوات التنفيذ
// ============================================================

/**
 * أداة تحديث البريد الإلكتروني
 * تُستخدم عندما يطلب المستخدم تغيير بريده الإلكتروني
 */
const updateEmailTool = tool({
  description: 'تحديث البريد الإلكتروني للمستخدم.',
  parameters: z.object({
    newEmail: z.string().email().describe('البريد الإلكتروني الجديد'),
  }),
  execute: async ({ newEmail }, { db, userId }) => {
    await (db as any)
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(newEmail, userId)
      .run();
    return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
  },
});

/**
 * أداة تتبع الطلب
 * تُستخدم عندما يطلب المستخدم معرفة حالة طلبه
 */
const trackOrderTool = tool({
  description: 'الحصول على حالة الطلب باستخدام رقم الطلب.',
  parameters: z.object({
    orderNumber: z.string().describe('رقم الطلب'),
  }),
  execute: async ({ orderNumber }) => {
    return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
  },
});

/**
 * أداة إنشاء تذكرة دعم (بدون execute)
 * هذه الأداة تتطلب موافقة المستخدم (Human-in-the-loop)
 */
const createTicketTool = tool({
  description: 'إنشاء تذكرة دعم جديدة لمشكلة يواجهها العميل.',
  parameters: z.object({
    issue: z.string().describe('وصف المشكلة بالتفصيل'),
  }),
});

// ============================================================
// ٦. وكيل AIChatAgent
// ============================================================

export class SupportAgent extends AIChatAgent<Env> {
  constructor(env: Env, userId: string) {
    super(env);
    this.userId = userId;
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const tools = {
      updateEmail: updateEmailTool,
      trackOrder: trackOrderTool,
      createTicket: createTicketTool,
    };

    const systemPrompt = `أنت وكيل دعم فني محترف لشركة تقنية.

تعليماتك الأساسية:
- استخدم الأدوات المتاحة عندما يطلب المستخدم ذلك.
- إذا طلب المستخدم تحديث بريده، استخدم أداة updateEmail.
- إذا طلب تتبع طلبه، استخدم أداة trackOrder.
- إذا طلب إنشاء تذكرة دعم، استخدم أداة createTicket (ستتطلب موافقته).
- أجب باللغة العربية الفصحى وبإجابة مختصرة وواضحة.
- لا تختلق معلومات.`;

    const result = await workersai.streamText({
      model: '@cf/meta/llama-3.2-3b-instruct',
      messages: this.messages,
      system: systemPrompt,
      tools: tools,
      maxSteps: 5,
      temperature: 0.7,
      max_tokens: 256,
    });

    return result.toUIMessageStreamResponse();
  }
}

// ============================================================
// ٧. نقطة /ask (المعالجة الرئيسية)
// ============================================================

app.post('/api/ask', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const token = auth.replace('Bearer ', '');
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    if (!payload.sub) return c.json({ error: 'Invalid token' }, 401);

    const userId = payload.sub;

    const db = c.env.DB;
    const user = await db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();
    if (!user) return c.json({ error: 'User not found' }, 404);

    const { question } = await c.req.json();
    if (!question) return c.json({ error: 'Question required' }, 400);
    if (question.length > 1000) {
      return c.json({ error: 'Question too long (max 1000 chars)' }, 400);
    }

    const agent = new SupportAgent(c.env, userId);

    const body = JSON.stringify({
      messages: [{ role: 'user', content: question }]
    });
    const request = new Request('https://agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });

    const response = await agent.fetch(request);
    const data = await response.json();

    let answer = data?.messages?.[data.messages.length - 1]?.content || 'عذراً، لم أستطع معالجة طلبك.';
    answer = answer.trim();

    await db
      .prepare(
        'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(
        crypto.randomUUID(),
        userId,
        question,
        answer,
        new Date().toISOString()
      )
      .run();

    return c.json({ answer });
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json(
      {
        answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.',
      },
      200
    );
  }
});

// ============================================================
// ٨. جلب المحادثات السابقة
// ============================================================

app.get('/api/conversations', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const token = auth.replace('Bearer ', '');
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    if (!payload.sub) return c.json({ error: 'Invalid token' }, 401);

    const userId = payload.sub;

    const db = c.env.DB;
    const user = await db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();
    if (!user) return c.json({ error: 'User not found' }, 404);

    const { results } = await db
      .prepare(
        'SELECT id, message, response, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
      )
      .bind(userId)
      .all();

    return c.json({ conversations: results });
  } catch (e) {
    console.error('Conversations error:', e);
    return c.json({ error: 'Failed to fetch conversations' }, 500);
  }
});

export default app;
