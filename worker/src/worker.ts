/**
 * نقطة الدخول الرئيسية للـ Worker
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { KairosAgent } from './agent';

// ✅ إعادة تصدير الكلاس المطلوب لـ Durable Objects
export { KairosAgent };

export type Env = {
  AI: Ai;
  DB: D1Database;
  JWT_SECRET: string;
  RATE_LIMIT_KV: KVNamespace;
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  KAIROS_AGENT: DurableObjectNamespace;
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
// ٣. تحديد معدل الطلبات (Rate Limiting)
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
// ٤. المصادقة (تسجيل الدخول)
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
// ٥. نقطة WebSocket للـ Think Agent
// ============================================================
app.get('/api/chat', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const token = auth.replace('Bearer ', '');
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    if (!payload.sub) return c.json({ error: 'Invalid token payload' }, 401);

    const userId = payload.sub;
    const agentId = `user-${userId}`;
    const agent = c.env.KAIROS_AGENT.get(
      c.env.KAIROS_AGENT.idFromName(agentId)
    );

    return agent.fetch(c.req.raw);
  } catch (e) {
    console.error('❌ Chat error:', e);
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return c.json({ error: `WebSocket error: ${errorMessage}` }, 500);
  }
});

// ============================================================
// ٦. نقطة /ask - مع دعم Think باستخدام agent.chat()
// ============================================================
app.post('/api/ask', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) {
      return c.json({ 
        answer: '⚠️ خطأ: لم يتم إرسال رمز المصادقة (Authorization header missing).'
      }, 200);
    }

    const token = auth.replace('Bearer ', '');
    let payload;
    try {
      payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    } catch (verifyError) {
      const msg = verifyError instanceof Error ? verifyError.message : 'Invalid token';
      return c.json({ 
        answer: `⚠️ خطأ في المصادقة: ${msg}`
      }, 200);
    }

    if (!payload.sub) {
      return c.json({ 
        answer: '⚠️ خطأ: رمز المصادقة لا يحتوي على معرف المستخدم (sub).'
      }, 200);
    }

    const userId = payload.sub;
    const { question } = await c.req.json();
    if (!question) {
      return c.json({ 
        answer: '⚠️ خطأ: لم يتم إرسال سؤال (question).'
      }, 200);
    }

    if (!c.env.KAIROS_AGENT) {
      return c.json({ 
        answer: '⚠️ خطأ في التكوين: KAIROS_AGENT غير موجود. تأكد من إعدادات wrangler.jsonc.'
      }, 200);
    }

    const agentId = `user-${userId}`;
    const agent = c.env.KAIROS_AGENT.get(
      c.env.KAIROS_AGENT.idFromName(agentId)
    );

    // ✅ استخدام agent.chat() مباشرة
    let result;
    try {
      if (typeof agent.chat === 'function') {
        result = await agent.chat(question);
      } else {
        // طريقة بديلة عبر fetch داخلي
        const chatReq = new Request('https://internal/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: question }]
          })
        });
        const chatResponse = await agent.fetch(chatReq);
        const data = await chatResponse.json();
        result = data?.messages?.[data.messages.length - 1]?.content || 'لم أستطع معالجة طلبك.';
      }
    } catch (innerError) {
      const innerMsg = innerError instanceof Error ? innerError.message : 'Unknown';
      console.error('❌ agent.chat() error:', innerError);
      return c.json({ 
        answer: `⚠️ حدث خطأ أثناء استدعاء الوكيل:\n- الرسالة: ${innerMsg}`
      }, 200);
    }

    // حفظ المحادثة في D1 للتوثيق (اختياري)
    try {
      const db = c.env.DB;
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(
          crypto.randomUUID(),
          userId,
          question,
          result,
          new Date().toISOString()
        )
        .run();
    } catch (dbError) {
      console.warn('⚠️ Failed to save conversation:', dbError);
    }

    return c.json({ answer: result });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    console.error('❌ Ask error:', e);
    return c.json({ 
      answer: `⚠️ حدث خطأ في النظام:\n📋 **تفاصيل الخطأ:**\n- **النوع:** ${e instanceof Error ? e.constructor.name : 'Unknown'}\n- **الرسالة:** ${errorMessage}`
    }, 200);
  }
});

// ============================================================
// ٧. جلب المحادثات السابقة
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
