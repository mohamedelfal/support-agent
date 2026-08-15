// ============================================================
// وكيل دعم عملاء - Support Agent Worker (نسخة التشخيص)
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
// 🤖 الوكيل الذكي (مع تشخيص الأخطاء)
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

        // ============================================================
        // 1. جلب آخر 5 محادثات للسياق
        // ============================================================
        const { results: history } = await db.prepare(
            `SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
        ).bind(userId).all();

        const contextMessages = [];
        for (const record of (history || []).reverse()) {
            contextMessages.push({ role: 'user', content: record.message });
            contextMessages.push({ role: 'assistant', content: record.response });
        }

        // ============================================================
        // 2. البحث في جدول المعرفة
        // ============================================================
        const knowledgeResults = await db.prepare(
            `SELECT question, answer FROM knowledge WHERE keywords LIKE ? OR question LIKE ? LIMIT 3`
        ).bind(`%${question}%`, `%${question}%`).all();

        let knowledgeContext = '';
        if (knowledgeResults.results && knowledgeResults.results.length > 0) {
            knowledgeContext = '📚 **السياسة الرسمية للشركة:**\n';
            for (const k of knowledgeResults.results) {
                knowledgeContext += `- س: ${k.question}\n  ج: ${k.answer}\n`;
            }
        } else {
            knowledgeContext = '⚠️ **تنبيه:** لا توجد إجابة رسمية مطابقة لهذا السؤال في قاعدة المعرفة. اعتذر بلطف واطلب من العميل إنشاء تذكرة.';
        }

        // ============================================================
        // 3. بناء System Prompt
        // ============================================================
        let historyText = '';
        if (contextMessages.length > 0) {
            historyText = '**سياق المحادثة السابقة:**\n';
            for (let i = 0; i < contextMessages.length; i += 2) {
                if (contextMessages[i] && contextMessages[i+1]) {
                    historyText += `العميل: ${contextMessages[i].content}\nالوكيل: ${contextMessages[i+1].content}\n`;
                }
            }
        }

        const systemPrompt = `أنت وكيل دعم عملاء محترف في شركة عالمية.
تعليماتك الأساسية:
- استخدم المعلومات من "السياسة الرسمية" فقط للرد على العملاء.
- إذا لم توجد المعلومة في السياسة الرسمية، اعتذر بلطف واطلب من العميل إنشاء تذكرة وسيتم الرد خلال ٢٤ ساعة.
- رد دائماً باللغة العربية الفصحى بأسلوب مهذب ورسمي.
- لا تقل أبداً "أنا نموذج لغوي" أو "أنا ذكاء اصطناعي"، بل قل "أنا وكيل الدعم الفني".
- حافظ على سرية بيانات العملاء ولا تطلب معلومات حساسة.

${historyText ? historyText : ''}

${knowledgeContext}

الآن، سؤال العميل الحالي: ${question}`;

        // ============================================================
        // 4. استدعاء Workers AI (مع تشخيص دقيق)
        // ============================================================
        let response;
        try {
            // 🔥 بنحاول نستخدم النموذج المباشر الأول (الأسرع والأكثر استقراراً)
            response = await c.env.AI.run(
                '@cf/meta/llama-3-8b-instruct', // نموذج مباشر بدل dynamic عشان نختبر
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: question }
                    ],
                    temperature: 0.2,
                    max_tokens: 800,
                }
            );
        } catch (aiError) {
            // لو فشل النموذج المباشر، نرجع الخطأ للمستخدم عشان نشخصه
            const errorMsg = (aiError as Error).message || 'خطأ غير معروف';
            console.error('❌ AI Error:', errorMsg);
            return c.json({ 
                answer: `⚠️ **خطأ في الذكاء الاصطناعي:** ${errorMsg}\n\nيرجى التأكد من تفعيل Workers AI في حسابك.` 
            }, 200);
        }

        // ============================================================
        // 5. معالجة دقيقة للاستجابة
        // ============================================================
        console.log('🔍 AI Response:', JSON.stringify(response, null, 2));

        const answer = 
            response?.response ||
            response?.choices?.[0]?.message?.content ||
            response?.result?.response ||
            response?.output?.text ||
            response?.content ||
            response?.text ||
            response?.message?.content ||
            null;

        if (!answer) {
            console.error('❌ No answer found in response:', JSON.stringify(response, null, 2));
            return c.json({ 
                answer: '⚠️ عذراً، استقبلت رداً فارغاً من الذكاء الاصطناعي. حاول مرة أخرى.' 
            }, 200);
        }

        // ============================================================
        // 6. حفظ المحادثة في D1
        // ============================================================
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
    } catch (e) {
        console.error('❌ Ask error:', e);
        // 🔥 هنا بنرجع سبب الخطأ الفعلي عشان نعرف المشكلة
        const errorMessage = (e as Error).message || 'خطأ غير معروف';
        return c.json({ 
            answer: `⚠️ **خطأ في النظام:** ${errorMessage}\n\nيرجى إرسال هذه الرسالة للمطور.` 
        }, 200);
    }
});

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
