/**
 * وكيل دعم عملاء - Kairos
 * 
 * المطور: محمد عنتر الفل (Mohamed Antar Elfal)
 * 
 * الميزات:
 * - System Prompt قصير ومركز
 * - كشف نية محسّن
 * - خروج تلقائي من الجلسات العالقة عند تغيير الموضوع
 * - لغة عربية فصحى فقط
 * - دقة في المعلومات مع الاعتراف بعدم المعرفة
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { Env } from './env';
import { checkRateLimit, loginUser, verifyUser } from './auth';
import {
  createSession,
  updateSession,
  deleteSession,
  getActiveSession,
  cleanExpiredSessions,
  SessionData,
} from './sessions';
import {
  executeUpdateEmail,
  executeTrackOrder,
  executeCreateTicket,
  executePasswordReset,
  getOpenTickets,
} from './tools';
import {
  handleKnowledgeQuestion,
} from './knowledge';
import { handleGeneralQuestion } from './handlers';
import { detectIntent } from './utils';

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
// ٣. المصادقة
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

    const result = await loginUser(c, c.env.DB, email);
    return c.json({ success: true, token: result.token, user: result.user });
  } catch (e) {
    console.error('Login error:', e);
    return c.json({ error: 'Login failed' }, 500);
  }
});

app.get('/api/auth/me', async (c) => {
  try {
    const user = await verifyUser(c, c.env.DB);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ user });
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// ============================================================
// ٤. نقطة /ask (المعالجة الرئيسية)
// ============================================================
app.post('/api/ask', async (c) => {
  try {
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const user = await verifyUser(c, c.env.DB);
    if (!user) return c.json({ error: 'Invalid token' }, 401);

    const userId = (user as any).id;

    const db = c.env.DB;
    const { question } = await c.req.json();
    if (!question) return c.json({ error: 'Question required' }, 400);
    if (question.length > 1000) {
      return c.json({ error: 'Question too long (max 1000 chars)' }, 400);
    }

    await cleanExpiredSessions(db);

    const activeSession = await getActiveSession(db, userId);
    let currentContext = activeSession?.data.context || { pendingGoal: null };

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

    // 🔥 معالجة النية الجديدة مع إلغاء الجلسة العالقة إذا تغير الموضوع
    const newIntentTypes: string[] = ['update_email', 'update_profile', 'track_order', 'create_ticket', 'password_reset'];
    if (newIntentTypes.includes(intent.type) || intent.type === 'knowledge' || intent.type === 'general') {
      // إذا كانت هناك جلسة نشطة والنية مختلفة عن الجلسة، نلغي الجلسة
      if (activeSession) {
        const currentStep = activeSession.data.step;
        // إذا كانت الجلسة في حالة انتظار (وليست idle) والنية مختلفة
        if (currentStep !== 'idle') {
          // إذا كانت النية جديدة (مختلفة عن الهدف الحالي)
          const currentGoal = activeSession.data.context.pendingGoal;
          if (currentGoal && intent.type !== currentGoal) {
            await deleteSession(db, activeSession.id);
          }
        }
      }

      // بدء جلسة جديدة إذا كانت النية تتطلب جلسة
      if (newIntentTypes.includes(intent.type)) {
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
          const openTickets = await getOpenTickets(db, userId);
          const ticketCount = openTickets.length;

          if (ticketCount > 0) {
            const ticketList = openTickets.map((t, i) =>
              `- التذكرة ${i+1}: رقم ${(t.id as string).slice(0, 8)}، الموضوع: ${(t.issue as string).slice(0, 50)}`
            ).join('\n');

            newSessionData.data.existingTickets = openTickets;
            newSessionData.context.ticketCount = ticketCount;
            newSessionData.context.existingTickets = openTickets;
            newSessionData.step = 'awaiting_ticket_confirm';

            await createSession(db, userId, newSessionData);
            return c.json({
              answer: `📋 لديك ${ticketCount} تذكرة مفتوحة حالياً:\n${ticketList}\n\nهل تريد إنشاء تذكرة جديدة لمشكلة مختلفة عن هذه التذاكر؟ (أجب بـ "نعم" أو "لا")`
            });
          } else {
            newSessionData.step = 'awaiting_ticket_issue';
            await createSession(db, userId, newSessionData);
            return c.json({
              answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.',
            });
          }
        }

        if (intent.type === 'password_reset') {
          newSessionData.step = 'awaiting_password_choice';
          await createSession(db, userId, newSessionData);
          return c.json({
            answer: '🔑 هل تريد:\n١. تغيير كلمة المرور (طريقة جديدة)\n٢. استرجاع كلمة المرور (إرسال رابط للبريد المسجل)\nالرجاء اختيار الرقم (١ أو ٢)',
          });
        }
      }

      // إذا كانت النية معرفية أو عامة، نتعامل معها مباشرة
      if (intent.type === 'knowledge') {
        const knowledgeResponse = await handleKnowledgeQuestion(c, db, userId, question);
        if (knowledgeResponse) return knowledgeResponse;
        return await handleGeneralQuestion(c, db, userId, question, currentContext);
      }

      if (intent.type === 'general') {
        return await handleGeneralQuestion(c, db, userId, question, currentContext);
      }
    }

    // معالجة الجلسة النشطة (إذا لم يتم إلغاؤها)
    if (activeSession) {
      const session = activeSession;
      const sessionData = session.data;
      const currentStep = sessionData.step;

      // التحقق من تغيير الموضوع داخل الجلسة (لحالات مثل "نعم" / "لا")
      if (intent.type === 'knowledge' || intent.type === 'general') {
        // إذا كان السؤال العام غير مرتبط بالجلسة، نلغي الجلسة ونجيب
        await deleteSession(db, session.id);
        if (intent.type === 'knowledge') {
          const knowledgeResponse = await handleKnowledgeQuestion(c, db, userId, question);
          if (knowledgeResponse) return knowledgeResponse;
        }
        return await handleGeneralQuestion(c, db, userId, question, {});
      }

      // --- حالة اختيار كلمة المرور ---
      if (currentStep === 'awaiting_password_choice') {
        if (intent.type === 'password_choice') {
          const choice = intent.data.choice;
          if (choice === '1' || choice === '١') {
            sessionData.step = 'awaiting_password_confirm';
            sessionData.data.passwordChoice = 'change';
            await updateSession(db, session.id, sessionData);
            return c.json({
              answer: '🔑 الرجاء كتابة كلمة المرور الجديدة التي ترغب في تعيينها.',
            });
          } else if (choice === '2' || choice === '٢') {
            const result = await executePasswordReset(db, userId, 'recover');
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
              answer: '⚠️ لم أفهم اختيارك. الرجاء اختيار ١ أو ٢.',
            });
          }
        } else {
          return c.json({
            answer: '⚠️ الرجاء اختيار ١ أو ٢.',
          });
        }
      }

      // --- حالة تأكيد كلمة المرور الجديدة ---
      if (currentStep === 'awaiting_password_confirm') {
        if (question.length >= 6) {
          const result = await executePasswordReset(db, userId, 'change', question);
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
            answer: '⚠️ كلمة المرور يجب أن تكون 6 أحرف على الأقل.',
          });
        }
      }

      // --- حالة التأكيد على التذكرة الجديدة ---
      if (currentStep === 'awaiting_ticket_confirm') {
        if (intent.type === 'confirm') {
          sessionData.step = 'awaiting_ticket_issue';
          sessionData.data = { existingTickets: sessionData.data.existingTickets };
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: '📌 الرجاء كتابة وصف المشكلة الجديدة بالتفصيل.',
          });
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء إنشاء التذكرة. كيف يمكنني مساعدتك؟',
          });
        }
      }

      // --- حالة انتظار وصف المشكلة للتذكرة ---
      if (currentStep === 'awaiting_ticket_issue') {
        if (question.length >= 5) {
          const words = question.split(' ').filter(w => w.length > 3);
          let title = words.slice(0, 5).join(' ');
          if (title.length > 50) title = title.slice(0, 50);
          if (!title) title = 'مشكلة غير محددة';

          sessionData.data.ticketIssue = question;
          sessionData.data.ticketTitle = title;
          sessionData.step = 'awaiting_ticket_title';
          await updateSession(db, session.id, sessionData);
          return c.json({
            answer: `📌 هل تريد إنشاء تذكرة بعنوان: "${title}"؟ (أجب بـ "نعم" أو "لا")`,
          });
        } else {
          return c.json({
            answer: '⚠️ الرجاء كتابة وصف أوضح (على الأقل 5 أحرف)، أو اكتب "إلغاء" للخروج.',
          });
        }
      }

      // --- حالة تأكيد عنوان التذكرة ---
      if (currentStep === 'awaiting_ticket_title') {
        if (intent.type === 'confirm') {
          const issue = sessionData.data.ticketIssue || 'مشكلة غير محددة';
          const result = await executeCreateTicket(db, userId, issue);

          const openTickets = await getOpenTickets(db, userId);
          const ticketCount = openTickets.length;

          const finalAnswer = `${result.message}\n\n📋 عدد التذاكر المفتوحة لديك حالياً: ${ticketCount}`;

          await deleteSession(db, session.id);
          await db
            .prepare(
              'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(crypto.randomUUID(), userId, question, finalAnswer, new Date().toISOString())
            .run();
          return c.json({ answer: finalAnswer });
        } else {
          await deleteSession(db, session.id);
          return c.json({
            answer: '👍 تم إلغاء إنشاء التذكرة. كيف يمكنني مساعدتك؟',
          });
        }
      }

      // --- تحديث البريد: انتظار البريد الجديد ---
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

      // --- تحديث البريد: انتظار الكود ---
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

      // --- تتبع الطلب: انتظار رقم الطلب ---
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

      // --- تتبع الطلب: التأكيد النهائي ---
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
          // نتحقق إذا كان هناك سؤال جديد
          const newIntent = detectIntent(question, {});
          if (newIntent.type === 'knowledge') {
            const knowledgeResponse = await handleKnowledgeQuestion(c, db, userId, question);
            if (knowledgeResponse) return knowledgeResponse;
          }
          if (newIntent.type === 'general') {
            return await handleGeneralQuestion(c, db, userId, question, {});
          }
          return c.json({
            answer: '👍 تم إلغاء تتبع الطلب. كيف يمكنني مساعدتك؟',
          });
        }
      }

      // --- حالة التوضيح ---
      if (currentStep === 'awaiting_clarification') {
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
            answer: '📝 لتحديث الاسم أو رقم الهاتف، يرجى التواصل مع فريق الدعم عبر البريد الإلكتروني support@company.com'
          });
        } else {
          return c.json({
            answer: '📝 لم أفهم ما تريد تحديثه بالضبط. هل تقصد تحديث بريدك الإلكتروني أم معلومات أخرى؟'
          });
        }
      }
    }

    // ============================================================
    // الحالة النهائية: إذا لم يتم التعامل مع السؤال
    // ============================================================
    // محاولة المعرفة أولاً
    const knowledgeResponse = await handleKnowledgeQuestion(c, db, userId, question);
    if (knowledgeResponse) return knowledgeResponse;

    // ثم الأسئلة العامة
    return await handleGeneralQuestion(c, db, userId, question, {});
  } catch (e) {
    console.error('❌ Ask error:', e);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
  }
});

// ============================================================
// ٥. جلب المحادثات السابقة
// ============================================================
app.get('/api/conversations', async (c) => {
  try {
    const user = await verifyUser(c, c.env.DB);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const userId = (user as any).id;

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
