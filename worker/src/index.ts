// ============================================================
// وكيل دعم عملاء - النهج المستقر (بدون AIChatAgent)
// إدارة المحادثة عبر D1 + كشف مباشر للأدوات
// تم التحسين: دعم الأرقام العربية والإنجليزية، تحسين الكشف عن الأدوات
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
// 🎯 الأدوات (الكشف المباشر المحسّن)
// ============================================================

/**
 * استخراج الأرقام من النصوص (تدعم العربية والإنجليزية)
 * مثال: "١٢٣٤" → "1234"، "1234" → "1234"
 */
function extractNumber(text: string): string | null {
    // تحويل الأرقام العربية إلى إنجليزية
    const arabicToEnglish: { [key: string]: string } = {
        '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
        '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
    };
    
    let normalized = text;
    for (const [arabic, english] of Object.entries(arabicToEnglish)) {
        normalized = normalized.replace(new RegExp(arabic, 'g'), english);
    }
    
    // البحث عن رقم (4 أرقام فأكثر) - يدعم الأرقام المفصولة بفواصل أو مسافات
    const match = normalized.match(/\b(\d{4,})\b/);
    return match ? match[1] : null;
}

/**
 * استخراج البريد الإلكتروني من النص
 */
function extractEmail(text: string): string | null {
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : null;
}

// أداة تحديث البريد الإلكتروني
async function updateProfile(db: D1Database, userId: string, newEmail: string): Promise<string> {
    try {
        await db.prepare(
            'UPDATE users SET email = ? WHERE id = ?'
        ).bind(newEmail, userId).run();
        return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
    } catch (error) {
        return `❌ فشل تحديث البريد الإلكتروني: ${(error as Error).message}`;
    }
}

// أداة الاستعلام عن حالة الطلب (محاكاة)
async function getOrderStatus(orderNumber: string): Promise<string> {
    return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

// ============================================================
// 🤖 نقطة /ask (مع تحسين الكشف)
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
        // 1. الكشف المباشر عن الأدوات (محسّن)
        // ============================================================

        // 1.1 تحديث البريد الإلكتروني
        const email = extractEmail(question);
        const isUpdateProfile = 
            question.includes('تحديث') && 
            (question.includes('بريد') || question.includes('إيميل') || 
             question.includes('ايميل') || question.includes('email') ||
             question.includes('الإيميل') || question.includes('الايميل'));

        if (email && isUpdateProfile) {
            const result = await updateProfile(db, userId, email);
            await db.prepare(
                `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
            ).bind(
                crypto.randomUUID(),
                userId,
                question,
                result,
                new Date().toISOString()
            ).run();
            return c.json({ answer: result });
        }

        // 1.2 الاستعلام عن حالة الطلب
        const orderNumber = extractNumber(question);
        const isOrderQuery = 
            question.includes('طلب') || 
            question.includes('شحنة') || 
            question.includes('تتبع') ||
            question.includes('Track') ||
            question.includes('Order') ||
            question.includes('طلبى') ||
            question.includes('طلبي');

        if (orderNumber && isOrderQuery) {
            const result = await getOrderStatus(orderNumber);
            await db.prepare(
                `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
            ).bind(
                crypto.randomUUID(),
                userId,
                question,
                result,
                new Date().toISOString()
            ).run();
            return c.json({ answer: result });
        }

        // ============================================================
        // 2. البحث عن سياسة في جدول المعرفة
        // ============================================================
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

        // ============================================================
        // 3. الأسئلة العامة (استخدام AI.run)
        // ============================================================

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

    } catch (e) {
        console.error('❌ Ask error:', e);
        return c.json({
            answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.'
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
