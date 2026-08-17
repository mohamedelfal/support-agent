/**
 * ============================================================
 * وكيل دعم عملاء - النسخة المحسّنة النهائية (v6.0)
 * 
 * التحسينات:
 * - تبسيط System Prompt وتركيزه على الدعم الفني
 * - تحسين التعامل مع "لا" في سياقات مختلفة
 * - تحسين الحفاظ على السياق عبر الجلسات
 * - توسيع قاعدة المعرفة للأسئلة العامة
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

type ConversationContext = {
  pendingGoal?: 'update_email' | 'track_order' | 'create_ticket' | null;
  orderNumber?: string;
  issueDescription?: string;
  lastAction?: string;
  userIntent?: string;
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
// ٥. نظام الجلسات مع سياق محسّن
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
    | 'awaiting_clarification'
    | 'awaiting_password_reset'; // حالة جديدة لإعادة تعيين كلمة المرور
  context: ConversationContext;
  data: {
    newEmail?: string;
    verificationCode?: string;
    orderNumber?: string;
    ticketIssue?: string;
    clarificationQuestion?: string;
    passwordResetEmail?: string;
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
      `INSERT INTO sessions (id, user_id, action, step, data, created_at, expires_at, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      'state_machine',
      initialData.step,
      JSON.stringify(initialData.data || {}),
      now,
      expiresAt,
      JSON.stringify(initialData.context || {})
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
      `UPDATE sessions
       SET step = ?, data = ?, created_at = ?, context = ?
       WHERE id = ?`
    )
    .bind(
      data.step,
      JSON.stringify(data.data || {}),
      now,
      JSON.stringify(data.context || {}),
      sessionId
    )
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
      `SELECT id, step, data, context
       FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, now)
    .first();
  if (!result) return null;
  return {
    id: result.id as string,
    data: {
      step: result.step as SessionData['step'],
      data: JSON.parse((result.data as string) || '{}'),
      context: JSON.parse((result.context as string) || '{}'),
    },
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

function detectIntent(
  question: string,
  context: ConversationContext
): {
  type:
    | 'update_email'
    | 'update_profile'
    | 'track_order'
    | 'shipping_policy'
    | 'create_ticket'
    | 'knowledge'
    | 'confirm'
    | 'cancel'
    | 'provide_email'
    | 'provide_code'
    | 'provide_order'
    | 'clarification_response'
    | 'password_reset'
    | 'general';
  data?: any;
} {
  const lower = question.toLowerCase();

  // 1. كشف الإلغاء
  if (lower.includes('إلغاء') || lower.includes('رجوع') || lower.includes('الغاء')) {
    return { type: 'cancel' };
  }

  // 2. كشف التأكيد (نعم، Yes، موافق)
  if (lower.includes('نعم') || lower.includes('yes') || lower.includes('موافق')) {
    return { type: 'confirm' };
  }

  // 3. كشف الأسئلة العامة (يجب أن يكون قبل create_ticket)
  const generalKeywords = ['ما هو', 'ما هي', 'ماذا', 'شرح', 'معنى', 'تعريف', 'ما دور', 'ما وظيفة', 'اقدم', 'اشهر'];
  if (generalKeywords.some(k => lower.includes(k))) {
    return { type: 'knowledge' };
  }

  // 4. كشف طلب إعادة تعيين كلمة المرور
  const passwordKeywords = ['نسيت', 'باسورد', 'كلمة السر', 'كلمة مرور', 'password', 'pass'];
  if (passwordKeywords.some(k => lower.includes(k))) {
    return { type: 'password_reset' };
  }

  // 5. كشف تحديث البريد الإلكتروني
  const updateKeywords = ['تحديث', 'تغيير', 'تعديل', 'تبديل', 'تجديد'];
  const emailKeywords = ['بريد', 'إيميل', 'ايميل', 'email', 'الإيميل', 'الايميل'];
  const hasUpdate = updateKeywords.some(k => lower.includes(k));
  const hasEmail = emailKeywords.some(k => lower.includes(k));

  if (hasUpdate && hasEmail) {
    return { type: 'update_email' };
  }

  // 6. كشف تحديث بيانات عامة
  if (hasUpdate && !hasEmail) {
    const profileKeywords = ['بيانات', 'حساب', 'معلومات', 'ملفي', 'بروفايل'];
    if (profileKeywords.some(k => lower.includes(k))) {
      return { type: 'update_profile' };
    }
  }

  // 7. كشف تتبع الطلب
  const orderKeywords = ['طلب', 'شحنة', 'تتبع', 'Track', 'Order', 'طلبى', 'طلبي', 'شحن'];
  const isOrderQuery = orderKeywords.some(k => lower.includes(k));
  const shippingTimeKeywords = ['مدة', 'وقت', 'كم', 'متي', 'متى', 'يستغرق', 'استلام', 'توصيل', 'شحن', 'وصول'];
  const isShippingTimeQuery = shippingTimeKeywords.some(k => lower.includes(k));

  if (context.pendingGoal === 'create_ticket') {
    if (lower.includes('تتبع') && isOrderQuery) {
      return { type: 'track_order' };
    }
    return { type: 'general' };
  }

  if (isOrderQuery && !isShippingTimeQuery) {
    return { type: 'track_order' };
  }

  // 8. كشف الاستفسار عن سياسة الشحن
  if (isShippingTimeQuery && (lower.includes('طلب') || lower.includes('شحن') || lower.includes('توصيل'))) {
    return { type: 'shipping_policy' };
  }

  // 9. كشف إنشاء تذكرة
  const ticketKeywords = ['تذكرة', 'شكوى', 'مشكلة', 'دعم', 'مساعدة'];
  if (ticketKeywords.some(k => lower.includes(k))) {
    return { type: 'create_ticket' };
  }

  // 10. كشف الأسئلة المعرفية الأخرى
  const knowledgeKeywords = [
    'سياسة', 'استرجاع', 'مرتجع', 'سعر', 'كلمة السر', 'باسورد', 'نسيت',
    'تسجيل', 'حساب', 'دفع', 'كارت', 'الذكاء الاصطناعي', 'ai',
    'تحليل', 'بيانات', 'وزن', 'ذري', 'فن', 'حديث', 'سباحة',
    'فراشة', 'صدر', 'باك', 'بحيرة', 'نهر', 'جبل', 'صحراء'
  ];
  if (knowledgeKeywords.some(k => lower.includes(k))) {
    return { type: 'knowledge' };
  }

  // 11. كشف البريد الإلكتروني
  const email = extractEmail(question);
  if (email) {
    return { type: 'provide_email', data: { email } };
  }

  // 12. كشف الكود
  const hasOnlyNumbers = /^\d+$/.test(question.trim());
  if (hasOnlyNumbers) {
    return { type: 'provide_code', data: { code: question.trim() } };
  }

  // 13. كشف رقم الطلب
  const order = extractNumber(question);
  if (order) {
    return { type: 'provide_order', data: { orderNumber: order } };
  }

  return { type: 'general' };
}

// ============================================================
// ٧. دالة توليد Embedding (RAG)
// ============================================================

async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  try {
    const response = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
      text: text
    });
    return response.embedding || [];
  } catch (error) {
    console.error('❌ Embedding error:', error);
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// ٨. التنفيذ الفعلي للأدوات
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
  issue: string,
  orderNumber?: string
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
  const fullIssue = orderNumber ? `الطلب رقم ${orderNumber}: ${issue}` : issue;
  await db
    .prepare(
      'INSERT INTO tickets (id, user_id, issue, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(ticketId, userId, fullIssue, 'open', now)
    .run();
  return `✅ تم إنشاء تذكرة دعم برقم ${ticketId.slice(
    0,
    8
  )}. سيقوم فريق الدعم بالرد خلال ٢٤ ساعة.`;
}

async function executePasswordReset(db: D1Database, userId: string): Promise<string> {
  try {
    // جلب البريد الإلكتروني للمستخدم
    const user = await db
      .prepare('SELECT email FROM users WHERE id = ?')
      .bind(userId)
      .first();
    
    if (!user) {
      return '❌ لم يتم العثور على بريد إلكتروني مسجل لهذا الحساب.';
    }
    
    const email = (user as any).email;
    return `✅ تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني (${email}). يرجى التحقق من صندوق الوارد (والرسائل غير المرغوب فيها).`;
  } catch (error) {
    return `❌ فشل إرسال رابط إعادة تعيين كلمة المرور: ${(error as Error).message}`;
  }
}

// ============================================================
// ٩. نقطة /ask (المعالجة الرئيسية)
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

    const activeSession = await getActiveSession(db, userId);
    let currentContext: ConversationContext = { pendingGoal: null };

    if (activeSession) {
      currentContext = activeSession.data.context || { pendingGoal: null };
    }

    const intent = detectIntent(question, currentContext);

    // معالجة الإلغاء
    if (intent.type === 'cancel') {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }
      return c.json({
        answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
      });
    }

    // معالجة النية الجديدة
    const newIntentTypes: string[] = ['update_email', 'update_profile', 'track_order', 'create_ticket', 'password_reset'];
    if (newIntentTypes.includes(intent.type)) {
      if (activeSession) {
        await deleteSession(db, activeSession.id);
      }

      const newSessionData: SessionData = {
        step: 'idle',
        context: { pendingGoal: intent.type as any },
        data: {},
      };

      if (intent.type === 'update_email') {
        newSessionData.step = 'awaiting_email';
        await createSession(db, userId, newSessionData);
        return c.json({
          answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
        });
      }

      if (intent.type === 'update_profile') {
        newSessionData.step = 'awaiting_clarification';
        newSessionData.data.clarificationQuestion =
          '📝 هل تقصد تحديث بريدك الإلكتروني، أم معلومات أخرى مثل الاسم أو رقم الهاتف؟';
        await createSession(db, userId, newSessionData);
        return c.json({
          answer: newSessionData.data.clarificationQuestion,
        });
      }

      if (intent.type === 'track_order') {
        newSessionData.step = 'awaiting_order';
        await createSession(db, userId, newSessionData);
        return c.json({
          answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه (أرقام فقط).',
        });
      }

      if (intent.type === 'create_ticket') {
        newSessionData.step = 'awaiting_ticket_issue';
        await createSession(db, userId, newSessionData);
        return c.json({
          answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.',
        });
      }

      if (intent.type === 'password_reset') {
        const result = await executePasswordReset(db, userId);
        await db
          .prepare(
            'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(crypto.randomUUID(), userId, question, result, new Date().toISOString())
          .run();
        return c.json({ answer: result });
      }
    }

    // معالجة الجلسة النشطة
    if (activeSession) {
      const session = activeSession;
      const sessionData = session.data;
      const currentStep = sessionData.step;

      let shouldCancel = false;
      if (currentStep === 'awaiting_email' || currentStep === 'awaiting_code') {
        const allowedIntents = ['provide_email', 'provide_code', 'confirm'];
        if (!allowedIntents.includes(intent.type)) {
          shouldCancel = true;
        }
      } else if (currentStep === 'awaiting_order' || currentStep === 'awaiting_order_confirm') {
        const allowedIntents = ['provide_order', 'confirm'];
        // إذا قال "لا"، نلغي الجلسة
        if (intent.type === 'cancel') {
          shouldCancel = true;
        } else if (!allowedIntents.includes(intent.type)) {
          shouldCancel = true;
        }
      } else if (currentStep === 'awaiting_ticket_issue' || currentStep === 'awaiting_ticket_confirm') {
        const allowedIntents = ['general', 'confirm'];
        if (intent.type === 'general') {
          shouldCancel = false;
        } else if (!allowedIntents.includes(intent.type)) {
          shouldCancel = true;
        }
      } else if (currentStep === 'awaiting_clarification') {
        shouldCancel = false;
        const lower = question.toLowerCase();
        if (lower.includes('بريد') || lower.includes('إيميل') || lower.includes('ايميل') || lower.includes('نعم')) {
          await deleteSession(db, session.id);
          const newSessionData: SessionData = {
            step: 'awaiting_email',
            context: { pendingGoal: 'update_email' },
            data: {},
          };
          await createSession(db, userId, newSessionData);
          return c.json({
            answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.',
          });
        } else if (lower.includes('اسم') || lower.includes('هاتف') || lower.includes('رقم') || lower.includes('لا')) {
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

      if (shouldCancel) {
        await deleteSession(db, session.id);
        if (intent.type === 'knowledge' || intent.type === 'shipping_policy') {
          return await handleKnowledgeQuestion(c, db, userId, question, intent.type);
        }
        if (intent.type === 'general') {
          return await handleGeneralQuestion(c, db, userId, question, currentContext);
        }
        return c.json({
          answer: '👍 تم إلغاء العملية الحالية. كيف يمكنني مساعدتك؟',
        });
      }

      // معالجة الخطوات المختلفة
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
          sessionData.context.orderNumber = order;
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
          // إذا كان هناك سؤال جديد بعد الإلغاء، نتعامل معه
          if (intent.type === 'general' || intent.type === 'knowledge') {
            return await handleGeneralQuestion(c, db, userId, question, {});
          }
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      if (currentStep === 'awaiting_ticket_issue') {
        if (question.length >= 5) {
          sessionData.context.issueDescription = question;
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
          const issue = sessionData.context.issueDescription || sessionData.data.ticketIssue || 'مشكلة غير محددة';
          const orderNumber = sessionData.context.orderNumber;
          const result = await executeCreateTicket(
            db,
            userId,
            issue,
            orderNumber
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
    // 3. الحالة العامة
    // ============================================================

    if (intent.type === 'knowledge' || intent.type === 'shipping_policy') {
      return await handleKnowledgeQuestion(c, db, userId, question, intent.type);
    }

    return await handleGeneralQuestion(c, db, userId, question, currentContext);
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
  }
});

// ============================================================
// دالة معالجة الأسئلة المعرفية (مع RAG باستخدام Embeddings)
// ============================================================
async function handleKnowledgeQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  intentType?: string
) {
  try {
    // 1. جلب جميع سجلات المعرفة
    const allKnowledge = await db
      .prepare('SELECT id, question, answer, embedding FROM knowledge')
      .all();

    // 2. توليد Embedding لسؤال العميل
    const questionEmbedding = await generateEmbedding(question, c.env);

    // 3. البحث عن أفضل تطابق
    let bestMatch: any = null;
    let highestSimilarity = -1;
    const THRESHOLD = 0.5; // تم تخفيض العتبة لتشمل المزيد من التطابقات

    if (questionEmbedding.length > 0 && allKnowledge.results) {
      for (const record of allKnowledge.results) {
        const recordEmbedding = record.embedding ? JSON.parse(record.embedding as string) : [];
        if (recordEmbedding.length > 0) {
          const similarity = cosineSimilarity(questionEmbedding, recordEmbedding);
          if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = record;
          }
        }
      }
    }

    // 4. إذا وجدنا تطابقاً
    if (bestMatch && highestSimilarity > THRESHOLD) {
      const answer = bestMatch.answer as string;
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString())
        .run();
      return c.json({ answer });
    }

    // 5. إذا كانت النية هي الاستفسار عن سياسة الشحن
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

    // 6. إذا لم نجد تطابقاً
    return await handleGeneralQuestion(c, db, userId, question, {});
  } catch (error) {
    console.error('❌ Knowledge error:', error);
    return await handleGeneralQuestion(c, db, userId, question, {});
  }
}

// ============================================================
// دالة معالجة الأسئلة العامة (مع System Prompt محسّن)
// ============================================================
async function handleGeneralQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  context: ConversationContext
) {
  const history = await db
    .prepare(
      'SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 3'
    )
    .bind(userId)
    .all();

  let historyContext = '';
  if (history.results && history.results.length > 0) {
    const reversed = history.results.reverse();
    historyContext = 'المحادثات السابقة (آخر 3 رسائل):\n';
    for (const rec of reversed) {
      historyContext += `- س: ${rec.message}\n- ج: ${rec.response}\n`;
    }
  }

  let contextInfo = '';
  if (context.pendingGoal) {
    contextInfo += `\nالهدف الحالي للعميل: ${context.pendingGoal}`;
  }
  if (context.orderNumber) {
    contextInfo += `\nرقم الطلب المذكور: ${context.orderNumber}`;
  }
  if (context.issueDescription) {
    contextInfo += `\nوصف المشكلة: ${context.issueDescription}`;
  }

  // System Prompt محسّن ومركز
  const systemPrompt = `أنت مساعد دعم فني محترف لشركة تقنية، اسمك "ناصر". دورك الأساسي هو مساعدة العملاء في حل مشكلاتهم التقنية والإدارية.

**قواعدك الأساسية:**
1. **كن موجزاً**: لا تزيد ردودك عن ٣ جمل، ما لم يطلب العميل تفاصيل إضافية.
2. **ركز على الدعم الفني**: أولويتك هي حل المشكلات التقنية والإدارية.
3. **الأسئلة العامة**: إذا سألك العميل عن شيء عام (مثل "ما هي أقدم بحيرة في مصر؟")، أجب باختصار ودقة (جملة واحدة)، ثم اعرض العودة إلى موضوع الدعم الفني.
4. **لا تكرر التعريف**: عرّف بنفسك مرة واحدة فقط في بداية المحادثة.
5. **آلية التراجع**: إذا لم تكن متأكداً من الإجابة، قل "لا أملك هذه المعلومة حالياً".

${historyContext ? `\n${historyContext}` : ''}
${contextInfo ? `\nمعلومات السياق الحالي:${contextInfo}` : ''}

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
