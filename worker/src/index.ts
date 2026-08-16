/**
 * ============================================================
 * وكيل دعم عملاء - مع نظام جلسات متكامل
 * يعتمد على D1 لإدارة المحادثات و AI.run للأسئلة العامة
 * 
 * الميزات:
 * - تحديث البريد الإلكتروني مع تأكيد عبر كود تحقق
 * - تتبع الطلب مع تأكيد رقم الطلب
 * - إنشاء تذكرة دعم مع وصف المشكلة وتأكيد
 * - التحقق من التذاكر المفتوحة قبل الإنشاء
 * - إدارة الجلسات لمتابعة تدفق المحادثة
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
// ٥. نظام الجلسات (إدارة تدفق المحادثة)
// ============================================================

type SessionData = {
  step:
    | 'idle'
    | 'awaiting_email'
    | 'awaiting_code'
    | 'awaiting_order'
    | 'awaiting_order_confirm'
    | 'awaiting_ticket_issue'
    | 'awaiting_ticket_confirm';
  data: {
    newEmail?: string;
    verificationCode?: string;
    orderNumber?: string;
    ticketIssue?: string;
  };
};

async function createSession(
  db: D1Database,
  userId: string,
  initialData: SessionData
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, action, step, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      id,
      userId,
      'state_machine',
      initialData.step,
      JSON.stringify(initialData),
      now,
      expiresAt
    )
    .run();
  return id;
}

async function updateSession(
  db: D1Database,
  sessionId: string,
  data: SessionData
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'UPDATE sessions SET step = ?, data = ?, created_at = ? WHERE id = ?'
    )
    .bind(data.step, JSON.stringify(data), now, sessionId)
    .run();
}

async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

async function getActiveSession(
  db: D1Database,
  userId: string
): Promise<{ id: string; data: SessionData } | null> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      'SELECT id, data FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
    )
    .bind(userId, now)
    .first();
  if (!result) return null;
  return {
    id: result.id as string,
    data: JSON.parse(result.data as string) as SessionData,
  };
}

async function cleanExpiredSessions(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}

// ============================================================
// ٦. أدوات مساعدة
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
// ٧. التنفيذ الفعلي للأدوات
// ============================================================

async function executeUpdateEmail(
  db: D1Database,
  userId: string,
  newEmail: string
): Promise<string> {
  try {
    await db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(newEmail, userId)
      .run();
    return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
  } catch (error) {
    return `❌ فشل تحديث البريد: ${(error as Error).message}`;
  }
}

async function executeTrackOrder(orderNumber: string): Promise<string> {
  return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

async function executeCreateTicket(
  db: D1Database,
  userId: string,
  issue: string
): Promise<string> {
  // التحقق من وجود تذكرة مفتوحة
  const openTicket = await db
    .prepare('SELECT id FROM tickets WHERE user_id = ? AND status = "open" LIMIT 1')
    .bind(userId)
    .first();

  if (openTicket) {
    return `📋 لديك تذكرة مفتوحة بالفعل برقم ${(openTicket as any).id.slice(0, 8)}. سيتم التواصل معك قريباً.`;
  }

  const ticketId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO tickets (id, user_id, issue, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(ticketId, userId, issue, 'open', now)
    .run();
  return `✅ تم إنشاء تذكرة دعم برقم ${ticketId.slice(
    0,
    8
  )}. سيقوم فريق الدعم بالرد خلال ٢٤ ساعة.`;
}

// ============================================================
// ٨. نقطة /ask (المعالجة الرئيسية مع نظام الجلسات)
// ============================================================

app.post('/api/ask', async (c) => {
  try {
    // المصادقة
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

    // تنظيف الجلسات المنتهية
    await cleanExpiredSessions(db);

    // جلب الجلسة النشطة
    const activeSession = await getActiveSession(db, userId);

    // معالجة أمر الإلغاء
    if (question.includes('إلغاء') || question.includes('رجوع')) {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }
      return c.json({
        answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
      });
    }

    // ============================================================
    // ٨.١ معالجة الجلسة النشطة
    // ============================================================
    if (activeSession) {
      const session = activeSession;
      const sessionData = session.data;
      const action = sessionData.step;

      // ٨.١.١ تحديث البريد: انتظار البريد الجديد
      if (action === 'awaiting_email') {
        const email = extractEmail(question);
        if (!email) {
          return c.json({
            answer: '⚠️ بريد إلكتروني غير صالح. حاول مرة أخرى (مثال: name@domain.com).',
          });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        sessionData.step = 'awaiting_code';
        sessionData.data = { newEmail: email, verificationCode: code };
        await updateSession(db, session.id, sessionData);
        return c.json({
          answer: `📧 تم استلام البريد: ${email}. تم إرسال كود تحقق وهمي: ${code}. أرسل الكود للتأكيد.`,
        });
      }

      // ٨.١.٢ تحديث البريد: انتظار الكود
      if (action === 'awaiting_code') {
        const entered = question.trim();
        const expected = sessionData.data.verificationCode;
        if (entered === expected) {
          const result = await executeUpdateEmail(
            db,
            userId,
            sessionData.data.newEmail!
          );
          await deleteSession(db, session.id);
          await db
            .prepare(
              'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
            .run();
          return c.json({ answer: result });
        } else {
          return c.json({
            answer: '⚠️ الكود غير صحيح. حاول مرة أخرى أو اكتب "إلغاء".',
          });
        }
      }

      // ٨.١.٣ تتبع الطلب: انتظار رقم الطلب
      if (action === 'awaiting_order') {
        const order = extractNumber(question);
        if (!order) {
          return c.json({
            answer: '⚠️ رقم طلب غير صالح. يجب أن يكون 4 أرقام أو أكثر.',
          });
        }
        sessionData.step = 'awaiting_order_confirm';
        sessionData.data = { orderNumber: order };
        await updateSession(db, session.id, sessionData);
        return c.json({
          answer: `🔍 هل رقم الطلب ${order} هو الصحيح؟ أجب بـ "نعم" أو "لا".`,
        });
      }

      // ٨.١.٤ تتبع الطلب: تأكيد رقم الطلب
      if (action === 'awaiting_order_confirm') {
        const lower = question.toLowerCase();
        if (lower.includes('نعم') || lower.includes('yes')) {
          const result = await executeTrackOrder(sessionData.data.orderNumber!);
          await deleteSession(db, session.id);
          await db
            .prepare(
              'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
            .run();
          return c.json({ answer: result });
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      // ٨.١.٥ إنشاء تذكرة: انتظار وصف المشكلة
      if (action === 'awaiting_ticket_issue') {
        if (question.length < 5) {
          return c.json({
            answer: '⚠️ الرجاء كتابة وصف أوضح (على الأقل 5 أحرف).',
          });
        }
        sessionData.step = 'awaiting_ticket_confirm';
        sessionData.data = { ticketIssue: question };
        await updateSession(db, session.id, sessionData);
        return c.json({
          answer: `📌 هل تريد إنشاء تذكرة بالمشكلة التالية:\n"${question}"\nأجب بـ "نعم" أو "لا".`,
        });
      }

      // ٨.١.٦ إنشاء تذكرة: التأكيد النهائي
      if (action === 'awaiting_ticket_confirm') {
        const lower = question.toLowerCase();
        if (lower.includes('نعم') || lower.includes('yes')) {
          const result = await executeCreateTicket(
            db,
            userId,
            sessionData.data.ticketIssue!
          );
          await deleteSession(db, session.id);
          await db
            .prepare(
              'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
            .run();
          return c.json({ answer: result });
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء إنشاء التذكرة. كيف يمكنني مساعدتك؟',
          });
        }
      }
    }

    // ============================================================
    // ٨.٢ بدء جلسات جديدة (حالة idle)
    // ============================================================

    // تحديث البريد الإلكتروني
    const email = extractEmail(question);
    const isUpdateProfile =
      question.includes('تحديث') &&
      (question.includes('بريد') || question.includes('إيميل') || question.includes('ايميل') || question.includes('email'));

    if (email && isUpdateProfile) {
      const sessionData: SessionData = {
        step: 'awaiting_email',
        data: {},
      };
      await createSession(db, userId, sessionData);
      return c.json({
        answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
      });
    }

    // تتبع الطلب
    const isOrderQuery =
      question.includes('طلب') ||
      question.includes('شحنة') ||
      question.includes('تتبع') ||
      question.includes('Track') ||
      question.includes('Order');

    if (isOrderQuery) {
      const sessionData: SessionData = {
        step: 'awaiting_order',
        data: {},
      };
      await createSession(db, userId, sessionData);
      return c.json({
        answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه (أرقام فقط).',
      });
    }

    // إنشاء تذكرة دعم
    if (
      question.includes('تذكرة') ||
      question.includes('شكوى') ||
      question.includes('مشكلة') ||
      question.includes('دعم')
    ) {
      const sessionData: SessionData = {
        step: 'awaiting_ticket_issue',
        data: {},
      };
      await createSession(db, userId, sessionData);
      return c.json({
        answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.',
      });
    }

    // ============================================================
    // ٨.٣ البحث في قاعدة المعرفة
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
    // ٨.٤ الأسئلة العامة (استخدام AI.run)
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
// ٩. جلب المحادثات السابقة
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
