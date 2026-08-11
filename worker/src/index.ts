// ============================================================
// وكيل الذكاء الاصطناعي - Support Agent Worker
// ============================================================
// هذا الملف هو النقطة الرئيسية لتشغيل وكيل الدعم الذكي.
// يتعامل مع طلبات المصادقة، المحادثة، وجلب سجل المحادثات،
// مع دعم AI Gateway لتقليل التكاليف وتحسين الأداء.
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

// ============================================================
// تعريف أنواع البيئة (Environment Variables)
// ============================================================
// هذه المتغيرات يتم حقنها من Cloudflare أثناء التشغيل،
// وتشمل مفاتيح الوصول ومعرفات الموارد المطلوبة.
// ============================================================
type Env = {
    AI: Ai;                         // ربط Workers AI (احتياطي)
    DB: D1Database;                 // قاعدة البيانات D1
    JWT_SECRET: string;             // المفتاح السري لتوقيع JWT
    RATE_LIMIT_KV: KVNamespace;     // تخزين مؤقت للحد من معدل الطلبات
    AI_GATEWAY_ID: string;          // معرف بوابة AI Gateway
    AI_GATEWAY_TOKEN: string;       // رمز المصادقة الخاص بـ AI Gateway
    CLOUDFLARE_ACCOUNT_ID: string;  // معرف حساب Cloudflare
};

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// رؤوس الأمان (Security Headers)
// ============================================================
// تحسين أمان التطبيق عبر منع هجمات XSS و Clickjacking وغيرها.
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

// ============================================================
// إعدادات CORS
// ============================================================
// السماح فقط للنطاقات المصرح لها بالاتصال بالـ API.
// ============================================================
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ============================================================
// نقاط فحص الصحة (Health Checks)
// ============================================================
// توفر هذه النقاط معلومات عن حالة التطبيق لخدمات المراقبة.
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
        return c.json(
            {
                status: 'not ready',
                timestamp: new Date().toISOString(),
                error: (error as Error).message,
            },
            503
        );
    }
});

// ============================================================
// الحد من معدل محاولات تسجيل الدخول (Rate Limiting)
// ============================================================
// يحد من عدد محاولات تسجيل الدخول لكل بريد إلكتروني خلال 15 دقيقة.
// ============================================================
async function checkRateLimit(env: Env, email: string): Promise<{ allowed: boolean; remaining?: number; retryAfter?: number }> {
    const kv = env.RATE_LIMIT_KV;
    const key = `login:${email}`;
    const now = Math.floor(Date.now() / 1000);
    const windowSize = 15 * 60; // 15 دقيقة
    const maxAttempts = 5;

    let data = (await kv.get(key, 'json')) as { attempts: number; firstAttempt: number } | null;

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
// المصادقة (Authentication)
// ============================================================
// توفير تسجيل الدخول باستخدام البريد الإلكتروني وتوليد JWT.
// ============================================================
app.post('/api/auth/login', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) return c.json({ error: 'Email required' }, 400);

        const rateLimit = await checkRateLimit(c.env, email);
        if (!rateLimit.allowed) {
            return c.json(
                {
                    error: `Too many login attempts. Please try again in ${rateLimit.retryAfter} seconds.`,
                    retryAfter: rateLimit.retryAfter,
                },
                429
            );
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

// ============================================================
// التحقق من صحة الجلسة الحالية
// ============================================================
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
// الوكيل الذكي - معالجة أسئلة المستخدمين
// ============================================================
// يستقبل سؤال المستخدم، يرسله إلى AI Gateway، ويعيد الإجابة.
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
        const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

        if (!user) {
            console.error('User not found:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

        const MAX_QUESTION_LENGTH = 1000;
        if (question.length > MAX_QUESTION_LENGTH) {
            return c.json(
                {
                    error: `Question is too long. Maximum ${MAX_QUESTION_LENGTH} characters allowed.`,
                },
                400
            );
        }

        // ============================================================
        // استدعاء AI Gateway
        // ============================================================
        // باستخدام الهيدر الصحيح cf-aig-authorization (وليس Authorization)
        // لتوثيق الطلب لدى Gateway.
        // ============================================================
        const gatewayId = c.env.AI_GATEWAY_ID;
        const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
        const url = `https://gateway.ai.cloudflare.com/v1/accounts/${accountId}/ai-gateway/${gatewayId}/workers-ai/@cf/qwen/qwen3-30b-a3b-fp8`;

        console.log('Calling AI Gateway:', url);

        const aiResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 🔥 الهيدر المطلوب لمصادقة Gateway حسب وثائق Cloudflare
                'cf-aig-authorization': `Bearer ${c.env.AI_GATEWAY_TOKEN}`,
            },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: 'أنت مساعد ذكي ومفيد. أجب باللغة العربية.' },
                    { role: 'user', content: question },
                ],
                temperature: 0.2,
                max_tokens: 800,
            }),
        });

        const responseText = await aiResponse.text();

        if (!aiResponse.ok) {
            console.error('AI Gateway error:', aiResponse.status, responseText);
            return c.json({ error: `AI service error: ${aiResponse.status}` }, 500);
        }

        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            return c.json({ error: 'Invalid response from AI service' }, 500);
        }

        const answer = data.response || data.result?.response || 'لم أستطع الإجابة.';

        // ============================================================
        // حفظ المحادثة في قاعدة البيانات
        // ============================================================
        await db
            .prepare(
                `INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)`
            )
            .bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString())
            .run();

        return c.json({ answer });
    } catch (e) {
        console.error('Ask error:', e);
        return c.json({ error: 'Internal error: ' + (e as Error).message }, 500);
    }
});

// ============================================================
// جلب سجل المحادثات السابقة للمستخدم
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
        const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

        if (!user) {
            console.error('User not found:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

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
