/**
 * ============================================================
 * وكيل دعم عملاء - نظام إدارة حالة (State Machine)
 * 
 * يعتمد هذا الوكيل على نهج "الروتينات" لإدارة تدفق المحادثة
 * خطوة بخطوة، مما يمنع التعلق ويضمن تجربة مستخدم سلسة.
 * 
 * الميزات الرئيسية:
 * - إدارة حالة واضحة (idle, awaiting_email, awaiting_code, ...)
 * - إلغاء سهل للعملية الحالية عبر كلمة "إلغاء" أو "رجوع"
 * - دعم كامل لتحديث البريد وتتبع الطلب وإنشاء التذاكر
 * - System Prompt مبسط ومركز على الهوية فقط
 * - توثيق احترافي لكل جزء من الكود
 * ============================================================
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

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
// ١. رؤوس الأمان و CORS والتحقق الصحي
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
// ٢. تحديد معدل الطلبات (Rate Limiting)
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
// ٣. المصادقة (تسجيل الدخول والتحقق من التوكن)
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
// ٤. أدوات مساعدة: استخراج البيانات من النصوص
// ============================================================

/** تحويل الأرقام العربية إلى إنجليزية واستخراج أول رقم مكون من 4 خانات فأكثر */
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

/** استخراج البريد الإلكتروني من النص */
function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

// ============================================================
// ٥. أدوات التنفيذ (العمليات الفعلية)
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
  // محاكاة - يمكن ربطها بجدول حقيقي
  return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

async function executeCreateTicket(
  db: D1Database,
  userId: string,
  issue: string
): Promise<string> {
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
// ٦. نظام الجلسات وإدارة الحالة (State Machine)
// ============================================================

/** تعريف بنية البيانات المخزنة في الجلسة */
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
      'state_machine', // action عام
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
// ٧. كشف النية الأولية (في حالة idle)
// ============================================================

function detectIntent(question: string):
  | 'update_email'
  | 'track_order'
  | 'create_ticket'
  | 'general' {
  const lower = question.toLowerCase();

  // تحديث البريد: يحتوي على بريد وكلمة تغيير/تحديث
  if (
    extractEmail(question) &&
    (lower.includes('تحديث') ||
      lower.includes('تغيير') ||
      lower.includes('تعديل') ||
      lower.includes('تبديل'))
  ) {
    return 'update_email';
  }

  // تتبع الطلب: يحتوي على رقم وكلمة طلب/تتبع
  if (
    extractNumber(question) &&
    (lower.includes('طلب') ||
      lower.includes('تتبع') ||
      lower.includes('شحنة') ||
      lower.includes('شحن'))
  ) {
    return 'track_order';
  }

  // إنشاء تذكرة: يحتوي على كلمات تذكرة/شكوى/مشكلة/دعم
  if (
    lower.includes('تذكرة') ||
    lower.includes('شكوى') ||
    lower.includes('مشكلة') ||
    lower.includes('دعم')
  ) {
    return 'create_ticket';
  }

  return 'general';
}

// ============================================================
// ٨. معالجة الأسئلة العامة (غير الموجهة لأداة)
// ============================================================

async function handleGeneralQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string
) {
  // 1. البحث في قاعدة المعرفة
  const words = question.split(' ').filter((w: string) => w.length > 2);
  for (const word of words) {
    const result = await db
      .prepare(
        'SELECT answer FROM knowledge WHERE question LIKE ? OR keywords LIKE ? LIMIT 1'
      )
      .bind(`%${word}%`, `%${word}%`)
      .all();
    if (result.results && result.results.length > 0) {
      const answer = result.results[0].answer as string;
      await saveConversation(db, userId, question, answer);
      return c.json({ answer });
    }
  }

  // 2. استخدام النموذج اللغوي
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

  const systemPrompt = `أنت وكيل دعم فني لشركة تقنية. هويتك: مساعد محترف، مهذب، ودقيق.
قواعدك الأساسية:
- استخدم اللغة العربية الفصحى.
- حافظ على الإجابات مختصرة (جملتين كحد أقصى).
- لا تختلق معلومات. استخدم الأدوات المتاحة فقط.
- إذا واجهت موقفاً لا تعرف كيفية معالجته، قل "سأقوم بتحويلك إلى أحد الممثلين البشريين".`;

  const fullPrompt = `${systemPrompt}\n\n${context ? context + '\n' : ''}سؤال العميل: ${question}`;

  let aiResponse;
  try {
    aiResponse = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0.7,
      max_tokens: 256,
    });
  } catch (err) {
    console.error('AI Error:', err);
    return c.json({ answer: '⚠️ عذراً، حدث عطل في الذكاء الاصطناعي. حاول مرة أخرى.' });
  }

  const answer = (aiResponse as any).response || '⚠️ لم أستطع معالجة طلبك.';
  await saveConversation(db, userId, question, answer);
  return c.json({ answer });
}

async function saveConversation(
  db: D1Database,
  userId: string,
  message: string,
  response: string
) {
  await db
    .prepare(
      'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(
      crypto.randomUUID(),
      userId,
      message,
      response,
      new Date().toISOString()
    )
    .run();
}

// ============================================================
// ٩. نقطة /ask (المعالجة الرئيسية)
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

    // جلب المستخدم
    const db = c.env.DB;
    const user = await db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();
    if (!user) return c.json({ error: 'User not found' }, 404);

    // قراءة السؤال
    const { question } = await c.req.json();
    if (!question) return c.json({ error: 'Question required' }, 400);
    if (question.length > 1000) {
      return c.json({ error: 'Question too long (max 1000 chars)' }, 400);
    }

    // تنظيف الجلسات المنتهية
    await cleanExpiredSessions(db);

    // جلب الجلسة النشطة أو إنشاء واحدة جديدة
    let session = await getActiveSession(db, userId);
    let sessionId: string;
    let sessionData: SessionData;

    if (session) {
      sessionId = session.id;
      sessionData = session.data;
    } else {
      sessionData = { step: 'idle', data: {} };
      sessionId = await createSession(db, userId, sessionData);
    }

    // معالجة أمر الإلغاء العام
    if (question.includes('إلغاء') || question.includes('رجوع')) {
      sessionData = { step: 'idle', data: {} };
      await updateSession(db, sessionId, sessionData);
      return c.json({
        answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
      });
    }

    // آلة الحالة
    switch (sessionData.step) {
      case 'idle': {
        const intent = detectIntent(question);
        if (intent === 'update_email') {
          sessionData.step = 'awaiting_email';
          await updateSession(db, sessionId, sessionData);
          return c.json({
            answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد.',
          });
        } else if (intent === 'track_order') {
          sessionData.step = 'awaiting_order';
          await updateSession(db, sessionId, sessionData);
          return c.json({
            answer: '📦 الرجاء كتابة رقم الطلب (أرقام فقط).',
          });
        } else if (intent === 'create_ticket') {
          sessionData.step = 'awaiting_ticket_issue';
          await updateSession(db, sessionId, sessionData);
          return c.json({
            answer: '📌 الرجاء كتابة وصف المشكلة بالتفصيل.',
          });
        } else {
          // سؤال عام
          return await handleGeneralQuestion(c, db, userId, question);
        }
      }

      case 'awaiting_email': {
        const email = extractEmail(question);
        if (!email) {
          return c.json({
            answer: '⚠️ بريد إلكتروني غير صالح. حاول مرة أخرى (مثال: name@domain.com).',
          });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        sessionData.step = 'awaiting_code';
        sessionData.data = { newEmail: email, verificationCode: code };
        await updateSession(db, sessionId, sessionData);
        return c.json({
          answer: `📧 تم استلام البريد: ${email}. تم إرسال كود تحقق وهمي: ${code}. أرسل الكود للتأكيد.`,
        });
      }

      case 'awaiting_code': {
        const entered = question.trim();
        const expected = sessionData.data.verificationCode;
        if (entered === expected) {
          const result = await executeUpdateEmail(
            db,
            userId,
            sessionData.data.newEmail!
          );
          sessionData = { step: 'idle', data: {} };
          await updateSession(db, sessionId, sessionData);
          await saveConversation(db, userId, question, result);
          return c.json({ answer: result });
        } else {
          return c.json({
            answer: '⚠️ الكود غير صحيح. حاول مرة أخرى أو اكتب "إلغاء".',
          });
        }
      }

      case 'awaiting_order': {
        const order = extractNumber(question);
        if (!order) {
          return c.json({
            answer: '⚠️ رقم طلب غير صالح. يجب أن يكون 4 أرقام أو أكثر.',
          });
        }
        sessionData.step = 'awaiting_order_confirm';
        sessionData.data = { orderNumber: order };
        await updateSession(db, sessionId, sessionData);
        return c.json({
          answer: `🔍 هل رقم الطلب ${order} هو الصحيح؟ أجب بـ "نعم" أو "لا".`,
        });
      }

      case 'awaiting_order_confirm': {
        const lower = question.toLowerCase();
        if (lower.includes('نعم') || lower.includes('yes')) {
          const result = await executeTrackOrder(
            sessionData.data.orderNumber!
          );
          sessionData = { step: 'idle', data: {} };
          await updateSession(db, sessionId, sessionData);
          await saveConversation(db, userId, question, result);
          return c.json({ answer: result });
        } else {
          sessionData = { step: 'idle', data: {} };
          await updateSession(db, sessionId, sessionData);
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      case 'awaiting_ticket_issue': {
        if (question.length < 5) {
          return c.json({
            answer: '⚠️ الرجاء كتابة وصف أوضح (على الأقل 5 أحرف).',
          });
        }
        sessionData.step = 'awaiting_ticket_confirm';
        sessionData.data = { ticketIssue: question };
        await updateSession(db, sessionId, sessionData);
        return c.json({
          answer: `📌 هل تريد إنشاء تذكرة بالمشكلة التالية:\n"${question}"\nأجب بـ "نعم" أو "لا".`,
        });
      }

      case 'awaiting_ticket_confirm': {
        const lower = question.toLowerCase();
        if (lower.includes('نعم') || lower.includes('yes')) {
          const result = await executeCreateTicket(
            db,
            userId,
            sessionData.data.ticketIssue!
          );
          sessionData = { step: 'idle', data: {} };
          await updateSession(db, sessionId, sessionData);
          await saveConversation(db, userId, question, result);
          return c.json({ answer: result });
        } else {
          sessionData = { step: 'idle', data: {} };
          await updateSession(db, sessionId, sessionData);
          return c.json({
            answer: '👍 تم إلغاء إنشاء التذكرة. كيف يمكنني مساعدتك؟',
          });
        }
      }

      default:
        // حالة غير معروفة – إعادة تعيين إلى idle
        sessionData = { step: 'idle', data: {} };
        await updateSession(db, sessionId, sessionData);
        return c.json({
          answer: '⚠️ حدث خطأ غير متوقع. لنعد من البداية.',
        });
    }
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
  }
});

// ============================================================
// ١٠. جلب المحادثات السابقة
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
