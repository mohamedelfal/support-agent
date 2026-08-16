/**
 * ============================================================
 * وكيل دعم عملاء - النسخة المحسّنة النهائية (v3.0)
 * 
 * تعتمد على أفضل ممارسات هندسة المطالبات وإدارة الحالة
 * وفقًا لأحدث وثائق Cloudflare (أغسطس 2026)
 * 
 * التحسينات الرئيسية:
 * - تحسين فهم السياق والتمييز بين النوايا المتشابهة
 * - تحسين التعامل مع الأخطاء الإملائية
 * - تحسين آلية التراجع والاعتراف بعدم المعرفة
 * - تحسين البحث في قاعدة المعرفة
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
    | 'awaiting_ticket_confirm'
    | 'awaiting_clarification';
  data: {
    newEmail?: string;
    verificationCode?: string;
    orderNumber?: string;
    ticketIssue?: string;
    clarificationQuestion?: string;
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
// ٦. أدوات مساعدة وكشف النية (محسّن)
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

// دالة محسّنة للكشف عن النية مع تمييز أفضل بين تتبع الطلب والاستفسار عن سياسة الشحن
function detectIntent(question: string): {
  type:
    | 'update_email'
    | 'update_profile'
    | 'track_order'
    | 'shipping_policy' // نية جديدة للاستفسار عن سياسة الشحن
    | 'create_ticket'
    | 'knowledge'
    | 'confirm'
    | 'cancel'
    | 'provide_email'
    | 'provide_code'
    | 'provide_order'
    | 'clarification_response'
    | 'general';
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

  // 3. كشف تحديث البريد الإلكتروني
  const updateKeywords = ['تحديث', 'تغيير', 'تعديل', 'تبديل', 'تجديد'];
  const emailKeywords = ['بريد', 'إيميل', 'ايميل', 'email', 'الإيميل', 'الايميل'];
  const hasUpdate = updateKeywords.some(k => lower.includes(k));
  const hasEmail = emailKeywords.some(k => lower.includes(k));

  if (hasUpdate && hasEmail) {
    return { type: 'update_email' };
  }

  // 4. كشف تحديث بيانات عامة
  if (hasUpdate && !hasEmail) {
    const profileKeywords = ['بيانات', 'حساب', 'معلومات', 'ملفي', 'بروفايل'];
    if (profileKeywords.some(k => lower.includes(k))) {
      return { type: 'update_profile' };
    }
  }

  // 5. كشف تتبع الطلب (يتطلب وجود كلمة "تتبع" أو "رقم" مع "طلب")
  const orderKeywords = ['طلب', 'شحنة', 'تتبع', 'Track', 'Order', 'طلبى', 'طلبي', 'شحن'];
  const isOrderQuery = orderKeywords.some(k => lower.includes(k));
  // إذا كان السؤال عن "وقت وصول الطلب" أو "مدة الشحن"، فهذا ليس تتبعاً بل استفسار عن سياسة
  const shippingTimeKeywords = ['مدة', 'وقت', 'كم', 'متي', 'متى', 'يستغرق', 'استلام', 'توصيل', 'شحن', 'وصول'];
  const isShippingTimeQuery = shippingTimeKeywords.some(k => lower.includes(k));

  if (isOrderQuery && !isShippingTimeQuery) {
    return { type: 'track_order' };
  }

  // 6. كشف الاستفسار عن سياسة الشحن (وقت الوصول، مدة التوصيل)
  if (isShippingTimeQuery && (lower.includes('طلب') || lower.includes('شحن') || lower.includes('توصيل'))) {
    return { type: 'shipping_policy' };
  }

  // 7. كشف إنشاء تذكرة
  const ticketKeywords = ['تذكرة', 'شكوى', 'مشكلة', 'دعم', 'مساعدة'];
  if (ticketKeywords.some(k => lower.includes(k))) {
    return { type: 'create_ticket' };
  }

  // 8. كشف الأسئلة المعرفية
  const knowledgeKeywords = [
    'سياسة',
    'استرجاع',
    'مرتجع',
    'سعر',
    'كلمة السر',
    'باسورد',
    'نسيت',
    'تسجيل',
    'حساب',
    'دفع',
    'كارت',
    'ما هو',
    'ماذا يعني',
    'شرح',
    'الذكاء الاصطناعي',
    'ai',
    'تحليل',
    'بيانات',
    'وزن',
    'ذري',
    'فن',
    'حديث',
    'سباحة',
    'فراشة',
    'صدر',
    'باك',
  ];
  if (knowledgeKeywords.some(k => lower.includes(k))) {
    return { type: 'knowledge' };
  }

  // 9. كشف البريد الإلكتروني
  const email = extractEmail(question);
  if (email) {
    return { type: 'provide_email', data: { email } };
  }

  // 10. كشف الكود
  const hasOnlyNumbers = /^\d+$/.test(question.trim());
  if (hasOnlyNumbers) {
    return { type: 'provide_code', data: { code: question.trim() } };
  }

  // 11. كشف رقم الطلب
  const order = extractNumber(question);
  if (order) {
    return { type: 'provide_order', data: { orderNumber: order } };
  }

  // 12. الحالة العامة
  return { type: 'general' };
}

// دالة محسّنة للتحقق من تغيير النية
function isNewIntentRequiringCancel(
  currentStep: string,
  intent: ReturnType<typeof detectIntent>
): boolean {
  if (intent.type === 'cancel') {
    return false;
  }

  if (currentStep === 'awaiting_email' || currentStep === 'awaiting_code') {
    const allowedIntents = ['provide_email', 'provide_code', 'confirm'];
    if (!allowedIntents.includes(intent.type)) {
      return true;
    }
  }

  if (currentStep === 'awaiting_order' || currentStep === 'awaiting_order_confirm') {
    const allowedIntents = ['provide_order', 'confirm'];
    if (!allowedIntents.includes(intent.type)) {
      return true;
    }
  }

  if (currentStep === 'awaiting_ticket_issue' || currentStep === 'awaiting_ticket_confirm') {
    const allowedIntents = ['general', 'confirm'];
    if (intent.type === 'general') {
      return false;
    }
    if (!allowedIntents.includes(intent.type)) {
      return true;
    }
  }

  if (currentStep === 'awaiting_clarification') {
    return true;
  }

  return false;
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

    await cleanExpiredSessions(db);

    const intent = detectIntent(question);
    const activeSession = await getActiveSession(db, userId);

    // 2.1 معالجة الإلغاء
    if (intent.type === 'cancel') {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }
      return c.json({
        answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
      });
    }

    // 2.2 معالجة النية الجديدة التي تبدأ جلسة جديدة
    const newIntentTypes: string[] = ['update_email', 'update_profile', 'track_order', 'create_ticket'];
    if (newIntentTypes.includes(intent.type)) {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }

      if (intent.type === 'update_email') {
        const sessionData: SessionData = { step: 'awaiting_email', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
        });
      }

      if (intent.type === 'update_profile') {
        const sessionData: SessionData = {
          step: 'awaiting_clarification',
          data: {
            clarificationQuestion:
              '📝 هل تقصد تحديث بريدك الإلكتروني، أم معلومات أخرى مثل الاسم أو رقم الهاتف؟',
          },
        };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: sessionData.data.clarificationQuestion,
        });
      }

      if (intent.type === 'track_order') {
        const sessionData: SessionData = { step: 'awaiting_order', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه (أرقام فقط).',
        });
      }

      if (intent.type === 'create_ticket') {
        const sessionData: SessionData = { step: 'awaiting_ticket_issue', data: {} };
        await createSession(db, userId, sessionData);
        return c.json({
          answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.',
        });
      }
    }

    // 2.3 معالجة الجلسة النشطة
    if (activeSession) {
      const session = activeSession;
      const sessionData = session.data;
      const currentStep = sessionData.step;

      if (isNewIntentRequiringCancel(currentStep, intent)) {
        await deleteSession(db, session.id);
        if (intent.type === 'knowledge' || intent.type === 'shipping_policy') {
          return await handleKnowledgeQuestion(c, db, userId, question, intent.type);
        }
        if (intent.type === 'general') {
          return await handleGeneralQuestion(c, db, userId, question);
        }
        return c.json({
          answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
        });
      }

      // معالجة الجلسة حسب الخطوة الحالية
      if (currentStep === 'awaiting_clarification') {
        const lower = question.toLowerCase();
        if (lower.includes('بريد') || lower.includes('إيميل') || lower.includes('ايميل')) {
          await deleteSession(db, session.id);
          const newSessionData: SessionData = { step: 'awaiting_email', data: {} };
          await createSession(db, userId, newSessionData);
          return c.json({
            answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
          });
        } else if (lower.includes('اسم') || lower.includes('هاتف') || lower.includes('رقم')) {
          await deleteSession(db, session.id);
          return c.json({
            answer: '📝 لتحديث الاسم أو رقم الهاتف، يرجى التواصل مع فريق الدعم عبر البريد الإلكتروني support@company.com',
          });
        } else {
          return c.json({
            answer: '📝 لم أفهم ما تريد تحديثه بالضبط. هل تقصد تحديث بريدك الإلكتروني أم معلومات أخرى؟',
          });
        }
      }

      if (currentStep === 'awaiting_email') {
        if (intent.type === 'provide_email' && intent.data?.email) {
          const email = intent.data.email;
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          sessionData.step = 'awaiting_code';
          sessionData.data = { newEmail: email, verificationCode: code };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `📧 تم استلام البريد: ${email}. تم إرسال كود تحقق وهمي: ${code}. أرسل الكود للتأكيد.`,
          });
        } else {
          return c.json({
            answer: '⚠️ بريد إلكتروني غير صالح. حاول مرة أخرى (مثال: name@domain.com)، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      if (currentStep === 'awaiting_code') {
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
        } else {
          return c.json({
            answer: '⚠️ يرجى إدخال الكود المكون من 6 أرقام، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      if (currentStep === 'awaiting_order') {
        if (intent.type === 'provide_order' && intent.data?.orderNumber) {
          const order = intent.data.orderNumber;
          sessionData.step = 'awaiting_order_confirm';
          sessionData.data = { orderNumber: order };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `🔍 هل رقم الطلب ${order} هو الصحيح؟ أجب بـ "نعم" أو "لا".`,
          });
        } else {
          return c.json({
            answer: '⚠️ رقم طلب غير صالح. يجب أن يكون 4 أرقام أو أكثر، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

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
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      if (currentStep === 'awaiting_ticket_issue') {
        if (question.length >= 5) {
          sessionData.step = 'awaiting_ticket_confirm';
          sessionData.data = { ticketIssue: question };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `📌 هل تريد إنشاء تذكرة بالمشكلة التالية:\n"${question}"\nأجب بـ "نعم" أو "لا".`,
          });
        } else {
          return c.json({
            answer: '⚠️ الرجاء كتابة وصف أوضح (على الأقل 5 أحرف)، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

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

    if (intent.type === 'knowledge' || intent.type === 'shipping_policy') {
      return await handleKnowledgeQuestion(c, db, userId, question, intent.type);
    }

    return await handleGeneralQuestion(c, db, userId, question);
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
  }
});

// ============================================================
// دالة معالجة الأسئلة المعرفية (محسّنة مع آلية للتراجع)
// ============================================================
async function handleKnowledgeQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  intentType?: string
) {
  // 1. محاولة البحث في قاعدة المعرفة
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

  // 2. إذا كانت النية هي الاستفسار عن سياسة الشحن، نقدم رداً بديلاً مفيداً
  if (intentType === 'shipping_policy') {
    const fallbackAnswer =
      '⏳ عادةً ما يستغرق وصول الطلب من ٣ إلى ٥ أيام عمل من تاريخ الشراء. يتم إرسال رقم تتبع على البريد الإلكتروني عند الشحن. هل يمكنني مساعدتك في شيء آخر؟';
    await db
      .prepare(
        'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
      .run();
    return c.json({ answer: fallbackAnswer });
  }

  // 3. إذا لم نجد في المعرفة، نستخدم AI.run مع System Prompt محسّن
  return await handleGeneralQuestion(c, db, userId, question);
}

// ============================================================
// دالة معالجة الأسئلة العامة (محسّنة مع System Prompt جديد)
// ============================================================
async function handleGeneralQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string
) {
  // جلب آخر 3 محادثات فقط للسياق
  const history = await db
    .prepare(
      'SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 3'
    )
    .bind(userId)
    .all();

  let context = '';
  if (history.results && history.results.length > 0) {
    const reversed = history.results.reverse();
    context = 'المحادثات السابقة (آخر 3 رسائل):\n';
    for (const rec of reversed) {
      context += `- س: ${rec.message}\n- ج: ${rec.response}\n`;
    }
  }

  // System Prompt محسّن وفق أفضل الممارسات
  const systemPrompt = `أنت مساعد دعم فني محترف لشركة تقنية، اسمك "ناصر". هدفك الأساسي هو مساعدة العملاء في حل مشكلاتهم بأسرع وقت ممكن.

شخصيتك: ودود، محترف، ومباشر. استخدم اللغة العربية الفصحى البسيطة.

قواعدك الأساسية:
1. **كن موجزاً**: لا تزيد ردودك عن ٣ جمل، إلا إذا طلب العميل تفاصيل إضافية.
2. **لا تكرر المعلومات**: إذا سبق وأن قدمت معلومات، لا تعيدها إلا إذا طُلب منك ذلك.
3. **التعامل مع الأخطاء الإملائية**: إذا كان السؤال يحتوي على أخطاء إملائية، حاول فهم المعنى المقصود وقدم إجابة مفيدة.
4. **آلية التراجع (Fallback)**: إذا لم تكن متأكداً من الإجابة، اعترف بذلك وقل "لا أملك هذه المعلومة حالياً. هل يمكنني مساعدتك في شيء آخر؟" بدلاً من التخمين.
5. **إذا كان السؤال عن سياسات الشركة**: استخدم المعلومات الرسمية من قاعدة المعرفة.
6. **حافظ على لهجة مهذبة ومحترفة**.
7. **تذكر السياق**: إذا كان السؤال مرتبطاً بمحادثة سابقة، استخدم هذا السياق لتقديم إجابة أفضل.

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
