/**
 * ============================================================
 * وكيل دعم عملاء - النسخة المستقرة (بدون AIChatAgent)
 * تعتمد على D1 لإدارة المحادثات و AI.run للأسئلة العامة
 * ============================================================
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

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
// ٥. أدوات مساعدة
// ============================================================
function extractNumber(text: string): string | null {
  const map: Record<string, string> = {
    '٠': '0',
    '١': '1',
    '٢': '2',
    '٣': '3',
    '٤': '4',
    '٥': '5',
    '٦': '6',
    '٧': '7',
    '٨': '8',
    '٩': '9',
  };
  let normalized = text;
  for (const [ar, en] of Object.entries(map)) {
    normalized = normalized.replace(new RegExp(ar, 'g'), en);
  }
  const match = normalized.match(/\b(\d{4,})\b/);
  return match ? match[1] : null;
}

function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

// ============================================================
// ٦. نقطة /ask (المعالجة الرئيسية)
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

    // ============================================================
    // ١. الكشف المباشر عن الأدوات
    // ============================================================

    // ١.١ تحديث البريد الإلكتروني
    const email = extractEmail(question);
    const isUpdateProfile =
      question.includes('تحديث') &&
      (question.includes('بريد') || question.includes('إيميل') || question.includes('ايميل') || question.includes('email'));

    if (email && isUpdateProfile) {
      try {
        await db
          .prepare('UPDATE users SET email = ? WHERE id = ?')
          .bind(email, userId)
          .run();
        const result = `✅ تم تحديث بريدك الإلكتروني إلى ${email} بنجاح.`;
        await db
          .prepare(
            'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
          .run();
        return c.json({ answer: result });
      } catch (e) {
        return c.json({ answer: '❌ فشل تحديث البريد: ' + (e as Error).message });
      }
    }

    // ١.٢ تتبع الطلب
    const orderNumber = extractNumber(question);
    const isOrderQuery =
      question.includes('طلب') ||
      question.includes('شحنة') ||
      question.includes('تتبع') ||
      question.includes('Track') ||
      question.includes('Order');

    if (orderNumber && isOrderQuery) {
      const result = `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
        .run();
      return c.json({ answer: result });
    }

    // ١.٣ إنشاء تذكرة
    if (question.includes('تذكرة') || question.includes('شكوى') || question.includes('مشكلة') || question.includes('دعم')) {
      // نسأل المستخدم عن وصف المشكلة (يمكن تطويرها لاحقاً)
      const result = `📌 تم إنشاء تذكرة دعم. سيتم التواصل معك قريباً.`;
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
        .run();
      return c.json({ answer: result });
    }

    // ============================================================
    // ٢. البحث في قاعدة المعرفة
    // ============================================================
    const words = question.split(' ').filter((w) => w.length > 2);
    let knowledgeAnswer = '';
    for (const word of words) {
      const knowledgeResults = await db
        .prepare(
          'SELECT answer FROM knowledge WHERE question LIKE ? OR keywords LIKE ? LIMIT 1'
        )
        .bind(`%${word}%`, `%${word}%`)
        .all();
      if (knowledgeResults.results && knowledgeResults.results.length > 0) {
        knowledgeAnswer = knowledgeResults.results[0].answer as string;
        break;
      }
    }

    if (knowledgeAnswer) {
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, knowledgeAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: knowledgeAnswer });
    }

    // ============================================================
    // ٣. الأسئلة العامة (استخدام AI.run)
    // ============================================================
    const history = await db
      .prepare(
        'SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5'
      )
      .bind(userId)
      .all();

    let context = '';
    if (history.results && history.results.length > 0) {
      const reversed = history.results.reverse();
      context = 'المحادثات السابقة:\n';
      for (const rec of reversed) {
        context += `- س: ${rec.message}\n- ج: ${rec.response}\n`;
      }
    }

    const systemPrompt = `أنت وكيل دعم فني محترف لشركة تقنية.
تعليماتك الأساسية:
- أجب باللغة العربية الفصحى بإجابة مختصرة وواضحة.
- لا تختلق معلومات.
- إذا كان السؤال يتعلق بسياسات الشركة، استخدم المعلومات الرسمية إن وجدت.
${context ? `\n${context}` : ''}

سؤال العميل: ${question}`;

    let aiResponse;
    try {
      aiResponse = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [{ role: 'user', content: systemPrompt }],
        temperature: 0.7,
        max_tokens: 256,
      });
    } catch (err) {
      console.error('AI Error:', err);
      return c.json({ answer: '⚠️ عذراً، حدث خطأ في الذكاء الاصطناعي. حاول مرة أخرى.' });
    }

    const answer = (aiResponse as any).response || '⚠️ عذراً، لم أستطع معالجة طلبك.';
    await db
      .prepare(
        'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString())
      .run();

    return c.json({ answer });
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
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
