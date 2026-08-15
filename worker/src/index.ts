// ============================================================
// وكيل دعم عملاء - مع نظام جلسات محسّن ومنع التعلق
// ============================================================

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
// Security Headers
// ============================================================
app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
});

// ============================================================
// CORS
// ============================================================
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ============================================================
// Health Checks
// ============================================================
app.get('/health/live', (c) => {
    return c.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

app.get('/health/ready', async (c) => {
    try {
        const db = c.env.DB;
        await db.prepare('SELECT 1').first();
        return c.json({
            status: 'ready',
            timestamp: new Date().toISOString(),
            services: { database: 'healthy' },
        });
    } catch (error) {
        return c.json({
            status: 'not ready',
            timestamp: new Date().toISOString(),
            error: (error as Error).message,
        }, 503);
    }
});

// ============================================================
// Rate Limiting
// ============================================================
async function checkRateLimit(env: Env, email: string): Promise<{ allowed: boolean; remaining?: number; retryAfter?: number }> {
    const kv = env.RATE_LIMIT_KV;
    const key = `login:${email}`;
    const now = Math.floor(Date.now() / 1000);
    const windowSize = 15 * 60;
    const maxAttempts = 5;

    let data = await kv.get(key, 'json') as { attempts: number; firstAttempt: number } | null;

    if (!data) {
        await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), { expirationTtl: windowSize });
        return { allowed: true, remaining: maxAttempts - 1 };
    }

    if (now - data.firstAttempt > windowSize) {
        await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), { expirationTtl: windowSize });
        return { allowed: true, remaining: maxAttempts - 1 };
    }

    const newAttempts = data.attempts + 1;
    await kv.put(key, JSON.stringify({ attempts: newAttempts, firstAttempt: data.firstAttempt }), { expirationTtl: windowSize });

    if (newAttempts > maxAttempts) {
        return {
            allowed: false,
            retryAfter: windowSize - (now - data.firstAttempt),
        };
    }

    return { allowed: true, remaining: maxAttempts - newAttempts };
}

// ============================================================
// Authentication
// ============================================================
app.post('/api/auth/login', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) return c.json({ error: 'Email required' }, 400);

        const rateLimit = await checkRateLimit(c.env, email);
        if (!rateLimit.allowed) {
            return c.json({
                error: `Too many login attempts. Please try again in ${rateLimit.retryAfter} seconds.`,
                retryAfter: rateLimit.retryAfter,
            }, 429);
        }

        const db = c.env.DB;
        const cleanEmail = email.trim().toLowerCase();

        let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
        if (!user) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
                .bind(id, cleanEmail, now)
                .run();
            user = { id, email: cleanEmail, created_at: now };
        }

        const token = await sign(
            { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
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
        const user = await db.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
            .bind(payload.sub)
            .first();

        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ user });
    } catch (e) {
        console.error('Me error:', e);
        return c.json({ error: 'Invalid token' }, 401);
    }
});

// ============================================================
// 🎯 نظام الجلسات
// ============================================================

async function createSession(db: D1Database, userId: string, action: string, step: string, data: any): Promise<string> {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await db.prepare(
        `INSERT INTO sessions (id, user_id, action, step, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, userId, action, step, JSON.stringify(data), now, expiresAt).run();

    return sessionId;
}

async function updateSessionStep(db: D1Database, sessionId: string, step: string, data?: any) {
    const now = new Date().toISOString();
    let query = `UPDATE sessions SET step = ?, data = ?, created_at = ? WHERE id = ?`;
    let params = [step, JSON.stringify(data || {}), now, sessionId];
    await db.prepare(query).bind(...params).run();
}

async function deleteSession(db: D1Database, sessionId: string) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

async function getActiveSession(db: D1Database, userId: string): Promise<any | null> {
    const now = new Date().toISOString();
    const result = await db.prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
    ).bind(userId, now).first();
    return result;
}

async function cleanExpiredSessions(db: D1Database) {
    const now = new Date().toISOString();
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}

// ============================================================
// 🎯 أدوات الاستخراج
// ============================================================

function extractNumber(text: string): string | null {
    const arabicToEnglish: { [key: string]: string } = {
        '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
        '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
    };
    let normalized = text;
    for (const [arabic, english] of Object.entries(arabicToEnglish)) {
        normalized = normalized.replace(new RegExp(arabic, 'g'), english);
    }
    const match = normalized.match(/\b(\d{4,})\b/);
    return match ? match[1] : null;
}

function extractEmail(text: string): string | null {
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : null;
}

// ============================================================
// 🎯 أدوات التنفيذ
// ============================================================

async function executeUpdateEmail(db: D1Database, userId: string, newEmail: string): Promise<string> {
    try {
        await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(newEmail, userId).run();
        return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
    } catch (error) {
        return `❌ فشل تحديث البريد الإلكتروني: ${(error as Error).message}`;
    }
}

async function executeTrackOrder(orderNumber: string): Promise<string> {
    return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

async function executeCreateTicket(db: D1Database, userId: string, issue: string): Promise<string> {
    const ticketId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
        `INSERT INTO tickets (id, user_id, issue, status, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(ticketId, userId, issue, 'open', now).run();
    return `✅ تم إنشاء تذكرة دعم برقم ${ticketId.slice(0, 8)}. سيقوم فريق الدعم بالرد خلال ٢٤ ساعة.`;
}

// ============================================================
// 🧠 كشف النية (Intent Detection)
// ============================================================

function detectIntent(question: string): { action: string; hasEmail?: string; hasOrder?: string; isConfirmation?: boolean } {
    const lower = question.toLowerCase();

    // 1. كشف التأكيد أو الإلغاء
    if (lower.includes('نعم') || lower.includes('yes') || lower.includes('موافق')) {
        return { action: 'confirm' };
    }
    if (lower.includes('لا') || lower.includes('no') || lower.includes('إلغاء') || lower.includes('الغاء')) {
        return { action: 'cancel' };
    }

    // 2. كشف البريد الإلكتروني
    const email = extractEmail(question);
    if (email) {
        return { action: 'has_email', hasEmail: email };
    }

    // 3. كشف رقم الطلب
    const order = extractNumber(question);
    if (order) {
        return { action: 'has_order', hasOrder: order };
    }

    // 4. كشف النية العامة
    const isUpdateProfile =
        question.includes('تحديث') &&
        (question.includes('بريد') || question.includes('إيميل') || question.includes('ايميل') || question.includes('email') ||
         question.includes('الإيميل') || question.includes('الايميل') || question.includes('تغيير') || question.includes('تعديل'));

    if (isUpdateProfile) {
        return { action: 'update_email' };
    }

    const isOrderQuery =
        question.includes('طلب') || question.includes('شحنة') || question.includes('تتبع') ||
        question.includes('Track') || question.includes('Order') || question.includes('طلبى') || question.includes('طلبي');

    if (isOrderQuery) {
        return { action: 'track_order' };
    }

    const isTicketRequest =
        question.includes('تذكرة') || question.includes('شكوى') || question.includes('مشكلة') ||
        question.includes('دعم') || question.includes('Ticket') || question.includes('ticket');

    if (isTicketRequest) {
        return { action: 'create_ticket' };
    }

    return { action: 'general' };
}

// ============================================================
// 🤖 نقطة /ask
// ============================================================

app.post('/api/ask', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET, 'HS256');

        if (!payload.sub) {
            return c.json({ error: 'Invalid token payload' }, 401);
        }

        const userId = payload.sub;

        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?')
            .bind(userId)
            .first();

        if (!user) {
            console.error('User not found:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

        const MAX_QUESTION_LENGTH = 1000;
        if (question.length > MAX_QUESTION_LENGTH) {
            return c.json({
                error: `Question is too long. Maximum ${MAX_QUESTION_LENGTH} characters allowed.`,
            }, 400);
        }

        await cleanExpiredSessions(db);
        const activeSession = await getActiveSession(db, userId);
        const intent = detectIntent(question);

        // ============================================================
        // 1. معالجة الجلسة النشطة
        // ============================================================
        if (activeSession) {
            const session = activeSession as any;
            const sessionData = JSON.parse(session.data);
            const action = session.action;
            const step = session.step;

            // 1.1 تحديث البريد - ننتظر البريد الجديد
            if (action === 'update_email' && step === 'awaiting_confirmation') {
                // إذا كان المستخدم يريد إلغاء الجلسة
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء تحديث البريد الإلكتروني. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                // إذا كان المستخدم يريد شيئاً آخر (نية مختلفة)
                if (intent.action !== 'has_email' && intent.action !== 'confirm') {
                    // نلغي الجلسة ونبدأ من جديد
                    await deleteSession(db, session.id);
                    // نعيد معالجة السؤال كطلب جديد
                    const newIntent = detectIntent(question);
                    if (newIntent.action === 'update_email' || newIntent.action === 'track_order' || newIntent.action === 'create_ticket') {
                        // سيتم معالجته في القسم 2
                    } else {
                        // سؤال عام
                        return await handleGeneralQuestion(c, db, userId, question);
                    }
                }

                // إذا كان البريد موجوداً
                if (intent.action === 'has_email' && intent.hasEmail) {
                    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
                    await updateSessionStep(db, session.id, 'awaiting_code', { newEmail: intent.hasEmail, code: verificationCode });
                    return c.json({
                        answer: `📧 تم استلام بريدك الإلكتروني الجديد: ${intent.hasEmail}. تم إرسال كود تحقق إلى بريدك القديم (محاكاة). الكود هو: ${verificationCode}. الرجاء إرسال الكود للتأكيد.`
                    });
                }

                // إذا لم يكن هناك بريد صحيح
                return c.json({
                    answer: '⚠️ يرجى كتابة البريد الإلكتروني الجديد بشكل صحيح (مثال: new@email.com)، أو اكتب "إلغاء" للخروج.'
                });
            }

            // 1.2 تحديث البريد - ننتظر الكود
            if (action === 'update_email' && step === 'awaiting_code') {
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء تحديث البريد الإلكتروني. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                const enteredCode = question.trim();
                const expectedCode = sessionData.code;
                if (enteredCode === expectedCode) {
                    const result = await executeUpdateEmail(db, userId, sessionData.newEmail);
                    await deleteSession(db, session.id);
                    await db.prepare(
                        `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
                    ).bind(crypto.randomUUID(), userId, question, result, new Date().toISOString()).run();
                    return c.json({ answer: result });
                } else {
                    return c.json({
                        answer: `⚠️ الكود غير صحيح. الرجاء إعادة إرسال الكود الصحيح، أو اكتب "إلغاء" للخروج.`
                    });
                }
            }

            // 1.3 تتبع الطلب - ننتظر رقم الطلب
            if (action === 'track_order' && step === 'awaiting_confirmation') {
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء تتبع الطلب. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                if (intent.action !== 'has_order' && intent.action !== 'confirm') {
                    await deleteSession(db, session.id);
                    return await handleGeneralQuestion(c, db, userId, question);
                }

                if (intent.action === 'has_order' && intent.hasOrder) {
                    await updateSessionStep(db, session.id, 'awaiting_final_confirm', { orderNumber: intent.hasOrder });
                    return c.json({
                        answer: `🔍 هل رقم الطلب ${intent.hasOrder} هو الصحيح؟ الرجاء الرد بـ "نعم" أو "لا".`
                    });
                }

                return c.json({
                    answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه (أرقام فقط).'
                });
            }

            // 1.4 تتبع الطلب - التأكيد النهائي
            if (action === 'track_order' && step === 'awaiting_final_confirm') {
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء تتبع الطلب. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                if (intent.action === 'confirm') {
                    const result = await executeTrackOrder(sessionData.orderNumber);
                    await deleteSession(db, session.id);
                    await db.prepare(
                        `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
                    ).bind(crypto.randomUUID(), userId, question, result, new Date().toISOString()).run();
                    return c.json({ answer: result });
                } else {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء تتبع الطلب. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }
            }

            // 1.5 إنشاء تذكرة - ننتظر وصف المشكلة
            if (action === 'create_ticket' && step === 'awaiting_issue') {
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء إنشاء التذكرة. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                if (question.length < 5) {
                    return c.json({
                        answer: '⚠️ الرجاء كتابة وصف أوضح للمشكلة التي تواجهها (على الأقل 5 أحرف)، أو اكتب "إلغاء" للخروج.'
                    });
                }

                await updateSessionStep(db, session.id, 'awaiting_final_confirm', { issue: question });
                return c.json({
                    answer: `📌 هل تريد إنشاء تذكرة دعم بالمشكلة التالية:\n\n"${question}"\n\nالرجاء الرد بـ "نعم" أو "لا".`
                });
            }

            // 1.6 إنشاء تذكرة - التأكيد النهائي
            if (action === 'create_ticket' && step === 'awaiting_final_confirm') {
                if (intent.action === 'cancel') {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء إنشاء التذكرة. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }

                if (intent.action === 'confirm') {
                    const result = await executeCreateTicket(db, userId, sessionData.issue);
                    await deleteSession(db, session.id);
                    await db.prepare(
                        `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
                    ).bind(crypto.randomUUID(), userId, question, result, new Date().toISOString()).run();
                    return c.json({ answer: result });
                } else {
                    await deleteSession(db, session.id);
                    return c.json({
                        answer: '👍 تم إلغاء إنشاء التذكرة. هل يمكنني مساعدتك بشيء آخر؟'
                    });
                }
            }
        }

        // ============================================================
        // 2. بدء جلسات جديدة (بناءً على النية)
        // ============================================================

        // 2.1 تحديث البريد الإلكتروني
        if (intent.action === 'update_email') {
            await createSession(db, userId, 'update_email', 'awaiting_confirmation', {});
            return c.json({
                answer: '📧 الرجاء كتابة البريد الإلكتروني الجديد الذي ترغب في تحديثه.'
            });
        }

        // 2.2 تتبع الطلب
        if (intent.action === 'track_order') {
            await createSession(db, userId, 'track_order', 'awaiting_confirmation', {});
            return c.json({
                answer: '📦 الرجاء كتابة رقم الطلب الذي ترغب في تتبعه.'
            });
        }

        // 2.3 إنشاء تذكرة دعم
        if (intent.action === 'create_ticket') {
            await createSession(db, userId, 'create_ticket', 'awaiting_issue', {});
            return c.json({
                answer: '📌 الرجاء كتابة وصف المشكلة التي تواجهها بالتفصيل.'
            });
        }

        // ============================================================
        // 3. معالجة الأسئلة العامة والسياسات
        // ============================================================

        return await handleGeneralQuestion(c, db, userId, question);

    } catch (e) {
        console.error('❌ Ask error:', e);
        return c.json({
            answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.'
        }, 200);
    }
});

// ============================================================
// 🧠 دالة معالجة الأسئلة العامة
// ============================================================

async function handleGeneralQuestion(c: any, db: D1Database, userId: string, question: string) {
    // البحث عن سياسة في جدول المعرفة
    const words = question.split(' ').filter(w => w.length > 2);
    let knowledgeAnswer = '';
    let foundKnowledge = false;

    for (const word of words) {
        const knowledgeResults = await db.prepare(
            `SELECT answer FROM knowledge 
             WHERE question LIKE ? OR keywords LIKE ? 
             LIMIT 1`
        ).bind(`%${word}%`, `%${word}%`).all();

        if (knowledgeResults.results && knowledgeResults.results.length > 0) {
            knowledgeAnswer = knowledgeResults.results[0].answer;
            foundKnowledge = true;
            break;
        }
    }

    if (foundKnowledge) {
        await db.prepare(
            `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(),
            userId,
            question,
            knowledgeAnswer,
            new Date().toISOString()
        ).run();
        return c.json({ answer: knowledgeAnswer });
    }

    // جلب آخر 5 محادثات للسياق
    const { results: history } = await db.prepare(
        `SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
    ).bind(userId).all();

    let contextText = '';
    if (history && history.length > 0) {
        const reversed = history.reverse();
        contextText = 'المحادثات السابقة مع العميل:\n';
        for (const record of reversed) {
            contextText += `- سؤال: ${record.message}\n- رد: ${record.response}\n`;
        }
    }

    const systemPrompt = `أنت وكيل دعم فني محترف في شركة عالمية.

تعليماتك الأساسية:
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.
- لا تكرر نفس الرد مرتين.
- لا تعطِ روابط أو تعليمات غير حقيقية.

${contextText ? `\n${contextText}\n` : ''}

سؤال العميل: ${question}`;

    let aiResponse;
    try {
        aiResponse = await c.env.AI.run(
            '@cf/meta/llama-3.2-3b-instruct',
            {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: question }
                ],
                temperature: 0.7,
                max_tokens: 256,
            }
        );
    } catch (aiError) {
        console.error('❌ AI Error:', aiError);
        return c.json({
            answer: '⚠️ عذراً، حدث خطأ في الذكاء الاصطناعي. حاول مرة أخرى.'
        }, 200);
    }

    let answer = (aiResponse as any).response || '⚠️ عذراً، لم أستطع معالجة طلبك.';
    answer = answer.trim();

    await db.prepare(
        `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(
        crypto.randomUUID(),
        userId,
        question,
        answer,
        new Date().toISOString()
    ).run();

    return c.json({ answer });
}

// ============================================================
// 📜 جلب المحادثات السابقة
// ============================================================
app.get('/api/conversations', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET, 'HS256');

        if (!payload.sub) {
            return c.json({ error: 'Invalid token payload' }, 401);
        }

        const userId = payload.sub;

        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?')
            .bind(userId)
            .first();

        if (!user) {
            console.error('User not found:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

        const { results } = await db.prepare(
            'SELECT id, message, response, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(userId).all();

        return c.json({ conversations: results });
    } catch (e) {
        console.error('Conversations error:', e);
        return c.json({ error: 'Failed to fetch conversations' }, 500);
    }
});

export default app;
