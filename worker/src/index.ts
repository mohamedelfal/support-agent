import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Env = {
    AI: Ai;
    DB: D1Database;
    JWT_SECRET: string;
    RATE_LIMIT_KV: KVNamespace; // 🔥 KV لتخزين محاولات الدخول
};

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// 🔒 رؤوس الأمان
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
// 🔒 CORS (مقيد)
// ============================================================
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ============================================================
// نقطة الصحة
// ============================================================
app.get('/health', (c) => c.json({ 
    status: 'ok', 
    service: 'AI Agent (Secure)',
    timestamp: new Date().toISOString()
}));

// ============================================================
// 🔐 المصادقة (مع Rate Limiting)
// ============================================================

// 🔥 دالة مساعدة للتحقق من معدل المحاولات
async function checkRateLimit(env: Env, email: string): Promise<{ allowed: boolean; remaining?: number; retryAfter?: number }> {
    const kv = env.RATE_LIMIT_KV;
    const key = `login:${email}`;
    const now = Math.floor(Date.now() / 1000);
    const windowSize = 15 * 60; // 15 دقيقة
    const maxAttempts = 5; // 5 محاولات كحد أقصى

    // جلب البيانات الحالية من KV
    let data = await kv.get(key, 'json') as { attempts: number; firstAttempt: number } | null;
    
    if (!data) {
        // أول محاولة
        await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), { expirationTtl: windowSize });
        return { allowed: true, remaining: maxAttempts - 1 };
    }

    // التحقق من انتهاء النافذة الزمنية
    if (now - data.firstAttempt > windowSize) {
        // إعادة تعيين النافذة
        await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), { expirationTtl: windowSize });
        return { allowed: true, remaining: maxAttempts - 1 };
    }

    // زيادة عدد المحاولات
    const newAttempts = data.attempts + 1;
    await kv.put(key, JSON.stringify({ attempts: newAttempts, firstAttempt: data.firstAttempt }), { expirationTtl: windowSize });

    if (newAttempts > maxAttempts) {
        return { 
            allowed: false, 
            retryAfter: windowSize - (now - data.firstAttempt) 
        };
    }

    return { allowed: true, remaining: maxAttempts - newAttempts };
}

app.post('/api/auth/login', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) return c.json({ error: 'Email required' }, 400);

        // 🔥 التحقق من معدل المحاولات
        const rateLimit = await checkRateLimit(c.env, email);
        if (!rateLimit.allowed) {
            return c.json({ 
                error: `Too many login attempts. Please try again in ${rateLimit.retryAfter} seconds.`,
                retryAfter: rateLimit.retryAfter 
            }, 429);
        }

        const db = c.env.DB;
        const cleanEmail = email.trim().toLowerCase();

        let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
        if (!user) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
                .bind(id, cleanEmail, now).run();
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

// ... (باقي نقاط النهاية كما هي)

// ============================================================
// 🤖 الوكيل الذكي (مع حد أقصى لطول السؤال)
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
            .bind(userId).first();

        if (!user) {
            console.error('User not found:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

        // 🔥 حد أقصى لطول السؤال (1000 حرف) لتقليل استهلاك النموذج
        const MAX_QUESTION_LENGTH = 1000;
        if (question.length > MAX_QUESTION_LENGTH) {
            return c.json({ 
                error: `Question is too long. Maximum ${MAX_QUESTION_LENGTH} characters allowed.` 
            }, 400);
        }

        const ai = c.env.AI;
        if (!ai) return c.json({ error: 'AI unavailable' }, 503);

        const response = await ai.run('@cf/qwen/qwen3-30b-a3b-fp8', {
            messages: [
                { role: 'system', content: 'أنت مساعد ذكي ومفيد. أجب باللغة العربية.' },
                { role: 'user', content: question }
            ],
            temperature: 0.2,
            max_tokens: 800,
        });

        const answer = response.response || 'لم أستطع الإجابة.';

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
        console.error('Ask error:', e);
        return c.json({ error: 'Internal error: ' + (e as Error).message }, 500);
    }
});

// ... (باقي نقاط النهاية كما هي)

export default app;
