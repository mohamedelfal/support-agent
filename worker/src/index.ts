/**
 * ============================================================
 * وكيل دعم عملاء - النسخة النهائية المستقرة
 * مع تحسين إدارة الجلسات ومنع التعلق نهائياً
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
// ٥. نظام الجلسات
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
// ٦. أدوات مساعدة وكشف النية
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

// دالة كشف النية الرئيسية - تعيد نوع النية بناءً على السؤال
function detectIntent(question: string): {
  type: 'update_email' | 'track_order' | 'create_ticket' | 'knowledge' | 'confirm' | 'cancel' | 'provide_email' | 'provide_code' | 'provide_order' | 'general';
  data?: any;
} {
  const lower = question.toLowerCase();

  // 1. كشف الإلغاء
  if (lower.includes('إلغاء') || lower.includes('رجوع') || lower.includes('الغاء')) {
    return { type: 'cancel' };
  }

  // 2. كشف التأكيد
  if (lower.includes('نعم') || lower.includes('yes') || lower.includes('موافق')) {
    return { type: 'confirm' };
  }

  // 3. كشف تحديث البريد الإلكتروني (يجب أن يحتوي على كلمة تحديث/تغيير + بريد)
  const updateKeywords = ['تحديث', 'تغيير', 'تعديل', 'تبديل', 'تجديد'];
  const emailKeywords = ['بريد', 'إيميل', 'ايميل', 'email', 'الإيميل', 'الايميل'];
  const hasUpdate = updateKeywords.some(k => lower.includes(k));
  const hasEmail = emailKeywords.some(k => lower.includes(k));
  
  if (hasUpdate && hasEmail) {
    return { type: 'update_email' };
  }

  // 4. كشف تتبع الطلب
  const orderKeywords = ['طلب', 'شحنة', 'تتبع', 'Track', 'Order', 'طلبى', 'طلبي', 'شحن'];
  if (orderKeywords.some(k => lower.includes(k))) {
    return { type: 'track_order' };
  }

  // 5. كشف إنشاء تذكرة
  const ticketKeywords = ['تذكرة', 'شكوى', 'مشكلة', 'دعم', 'مساعدة', 'استفسار'];
  if (ticketKeywords.some(k => lower.includes(k))) {
    return { type: 'create_ticket' };
  }

  // 6. كشف الأسئلة المعرفية (سياسات، معلومات عامة)
  const knowledgeKeywords = ['سياسة', 'استرجاع', 'شحن', 'سعر', 'كلمة السر', 'باسورد', 'نسيت', 'تسجيل', 'حساب', 'دفع', 'كارت'];
  if (knowledgeKeywords.some(k => lower.includes(k))) {
    return { type: 'knowledge' };
  }

  // 7. كشف البريد الإلكتروني (إذا كان السؤال يحتوي على بريد صالح)
  const email = extractEmail(question);
  if (email) {
    return { type: 'provide_email', data: { email } };
  }

  // 8. كشف الكود (إذا كان السؤال أرقام فقط)
  const hasOnlyNumbers = /^\d+$/.test(question.trim());
  if (hasOnlyNumbers) {
    return { type: 'provide_code', data: { code: question.trim() } };
  }

  // 9. كشف رقم الطلب (4 أرقام فأكثر)
  const order = extractNumber(question);
  if (order) {
    return { type: 'provide_order', data: { orderNumber: order } };
  }

  // 10. الحالة العامة
  return { type: 'general' };
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
// ٨. نقطة /ask (المعالجة الرئيسية)
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

    // تنظيف الجلسات المنتهية
    await cleanExpiredSessions(db);

    // 1. كشف نية السؤال الحالي
    const intent = detectIntent(question);

    // 2. جلب الجلسة النشطة إن وجدت
    const activeSession = await getActiveSession(db, userId);

    // ============================================================
    // 2.1 معالجة الإلغاء
    // ============================================================
    if (intent.type === 'cancel') {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }
      return c.json({
        answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
      });
    }

    // ============================================================
    // 2.2 معالجة النية الجديدة (تبدأ جلسة جديدة أو ترد مباشرة)
    // ============================================================
    // إذا كانت النية من نوع يبدأ جلسة جديدة أو سؤال معرفي، نلغي أي جلسة حالية
    const newIntentTypes: string[] = ['update_email', 'track_order', 'create_ticket', 'knowledge'];
    if (newIntentTypes.includes(intent.type)) {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }

      // تحديث البريد
      if (intent.type === 'update_email') {
        const sessionData: SessionData = { step: 'awaiting_email', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
        });
      }

      // تتبع الطلب
      if (intent.type === 'track_order') {
        const sessionData: SessionData = { step: 'awaiting_order', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه (أرقام فقط).',
        });
      }

      // إنشاء تذكرة
      if (intent.type === 'create_ticket') {
        const sessionData: SessionData = { step: 'awaiting_ticket_issue', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.',
        });
      }

      // الأسئلة المعرفية (سياسات، معلومات عامة) - نرد مباشرة بدون جلسة
      if (intent.type === 'knowledge') {
        // البحث في قاعدة المعرفة
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

        // إذا لم نجد في المعرفة، نستخدم AI.run
        return await handleGeneralQuestion(c, db, userId, question);
      }
    }

    // ============================================================
    // 2.3 معالجة الجلسة النشطة (إذا كانت موجودة والنية ليست جديدة)
    // ============================================================
    if (activeSession) {
      const session = activeSession;
      const sessionData = session.data;
      const currentStep = sessionData.step;

      // 2.3.1 تحديث البريد: انتظار البريد الجديد
      if (currentStep === 'awaiting_email') {
        // إذا كانت النية provide_email (تحتوي على بريد صالح)
        if (intent.type === 'provide_email' && intent.data?.email) {
          const email = intent.data.email;
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          sessionData.step = 'awaiting_code';
          sessionData.data = { newEmail: email, verificationCode: code };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `📧 تم استلام البريد: ${email}. تم إرسال كود تحقق وهمي: ${code}. أرسل الكود للتأكيد.`,
          });
        }
        // إذا كانت النية general أو knowledge أو أي شيء آخر، نلغي الجلسة ونجيب على السؤال
        else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          // نعيد معالجة السؤال كسؤال عام
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          return c.json({
            answer: '⚠️ بريد إلكتروني غير صالح. حاول مرة أخرى (مثال: name@domain.com)، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      // 2.3.2 تحديث البريد: انتظار الكود
      if (currentStep === 'awaiting_code') {
        // إذا كانت النية provide_code (أرقام)
        if (intent.type === 'provide_code' && intent.data?.code) {
          const entered = intent.data.code;
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
        // إذا كانت النية general أو knowledge أو أي شيء آخر، نلغي الجلسة ونجيب على السؤال
        else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          return c.json({
            answer: '⚠️ يرجى إدخال الكود المكون من 6 أرقام، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      // 2.3.3 تتبع الطلب: انتظار رقم الطلب
      if (currentStep === 'awaiting_order') {
        if (intent.type === 'provide_order' && intent.data?.orderNumber) {
          const order = intent.data.orderNumber;
          sessionData.step = 'awaiting_order_confirm';
          sessionData.data = { orderNumber: order };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `🔍 هل رقم الطلب ${order} هو الصحيح؟ أجب بـ "نعم" أو "لا".`,
          });
        } else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          return c.json({
            answer: '⚠️ رقم طلب غير صالح. يجب أن يكون 4 أرقام أو أكثر، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      // 2.3.4 تتبع الطلب: التأكيد النهائي
      if (currentStep === 'awaiting_order_confirm') {
        if (intent.type === 'confirm') {
          const result = await executeTrackOrder(sessionData.data.orderNumber!);
          await deleteSession(db, session.id);
          await db
            .prepare(
              'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
            .run();
          return c.json({ answer: result });
        } else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      // 2.3.5 إنشاء تذكرة: انتظار وصف المشكلة
      if (currentStep === 'awaiting_ticket_issue') {
        if (question.length >= 5) {
          sessionData.step = 'awaiting_ticket_confirm';
          sessionData.data = { ticketIssue: question };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `📌 هل تريد إنشاء تذكرة بالمشكلة التالية:\n"${question}"\nأجب بـ "نعم" أو "لا".`,
          });
        } else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          return c.json({
            answer: '⚠️ الرجاء كتابة وصف أوضح (على الأقل 5 أحرف)، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      // 2.3.6 إنشاء تذكرة: التأكيد النهائي
      if (currentStep === 'awaiting_ticket_confirm') {
        if (intent.type === 'confirm') {
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
        } else if (intent.type === 'general' || intent.type === 'knowledge') {
          await deleteSession(db, session.id);
          return await handleGeneralQuestion(c, db, userId, question);
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء إنشاء التذكرة. كيف يمكنني مساعدتك؟',
          });
        }
      }
    }

    // ============================================================
    // 3. الحالة العامة (بدون جلسة نشطة)
    // ============================================================
    return await handleGeneralQuestion(c, db, userId, question);

  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
  }
});

// ============================================================
// دالة معالجة الأسئلة العامة
// ============================================================
async function handleGeneralQuestion(c: any, db: D1Database, userId: string, question: string) {
  // البحث في قاعدة المعرفة
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

  // استخدام AI.run
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

  const systemPrompt = `أنت وكيل دعم فني محترف.
تعليماتك الأساسية:
- أجب باللغة العربية الفصحى بإجابة مختصرة وواضحة.
- لا تكرر نفس الإجابة.
- إذا كان السؤال عن سياسات الشركة، استخدم المعلومات الرسمية.
${context ? `\n${context}` : ''}

سؤال العميل: ${question}`;

  let aiResponse;
  try {
    aiResponse = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: systemPrompt }],
      temperature: 0.7,
      max_tokens: 256,
      repetition_penalty: 1.1,
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
}

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
