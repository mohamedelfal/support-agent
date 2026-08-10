// ============================================================
// وكيل الذكاء الاصطناعي - Worker API
// مع مصادقة البريد الإلكتروني وربط المحادثات بالمستخدم
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Env = {
    AI: Ai;
    DB: D1Database;
    JWT_SECRET: string;
};

type User = {
    id: string;
    email: string;
    created_at: string;
};

const app = new Hono<{ Bindings: Env }>();

// --- CORS ---
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
}));

// --- نقطة الصحة ---
app.get('/health', (c) => c.json({ 
    status: 'ok', 
    service: 'AI Agent (Qwen3-30B)',
    timestamp: new Date().toISOString()
}));

// ============================================================
// المصادقة (Authentication)
// ============================================================

// --- تسجيل الدخول / إنشاء مستخدم ---
app.post('/api/auth/login', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) {
            return c.json({ error: 'البريد الإلكتروني مطلوب' }, 400);
        }

        const db = c.env.DB;
        const cleanEmail = email.trim().toLowerCase();

        // البحث عن المستخدم أو إنشاؤه
        let user = await db.prepare(
            'SELECT * FROM users WHERE email = ?'
        ).bind(cleanEmail).first() as User | null;

        if (!user) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            await db.prepare(
                'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
            ).bind(id, cleanEmail, now).run();
            user = { id, email: cleanEmail, created_at: now };
        }

        // إنشاء JWT
        const token = await sign(
            { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
            c.env.JWT_SECRET
        );

        return c.json({
            success: true,
            token,
            user: { id: user.id, email: user.email }
        });

    } catch (error) {
        console.error('Login error:', error);
        return c.json({ error: 'حدث خطأ أثناء تسجيل الدخول' }, 500);
    }
});

// --- التحقق من الجلسة ---
app.get('/api/auth/me', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) {
            return c.json({ error: 'غير مصرح' }, 401);
        }

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);

        const db = c.env.DB;
        const user = await db.prepare(
            'SELECT id, email, created_at FROM users WHERE id = ?'
        ).bind(payload.sub).first();

        if (!user) {
            return c.json({ error: 'المستخدم غير موجود' }, 404);
        }

        return c.json({ user });

    } catch (error) {
        return c.json({ error: 'توكن غير صالح' }, 401);
    }
});

// ============================================================
// الوكيل الذكي (مع ربط المحادثات بالمستخدم)
// ============================================================

// --- استقبال السؤال (مع المصادقة) ---
app.post('/api/ask', async (c) => {
    try {
        // التحقق من التوكن
        const auth = c.req.header('Authorization');
        if (!auth) {
            return c.json({ error: 'غير مصرح' }, 401);
        }

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);
        const userId = payload.sub;

        const { question } = await c.req.json();
        if (!question) {
            return c.json({ error: 'السؤال مطلوب' }, 400);
        }

        const ai = c.env.AI;
        if (!ai) {
            return c.json({ error: 'AI service not available' }, 503);
        }

        const db = c.env.DB;

        // استدعاء النموذج
        const response = await ai.run('@cf/qwen/qwen3-30b-a3b-fp8', {
            messages: [
                { 
                    role: 'system', 
                    content: `أنت وكيل دعم عملاء محترف يتحدث العربية بطلاقة.
                    - استخدم اللغة العربية الفصحى الواضحة والمفهومة.
                    - كن دقيقاً في المعلومات ولا تختلق حقائق.
                    - إذا لم تعرف الإجابة، قل ذلك بوضوح دون تردد.
                    - حافظ على التماسك المنطقي في الإجابات الطويلة.
                    - استخدم أسلوباً مهذباً ومحترماً.
                    - قدم إجابات شاملة ولكن موجزة.`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.2,
            max_tokens: 800,
        });

        const answer = response.response || 'لم أستطع الإجابة على هذا السؤال.';

        // حفظ المحادثة مع user_id
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

    } catch (error) {
        console.error('AI Error:', error);
        return c.json({ error: 'حدث خطأ أثناء معالجة الطلب' }, 500);
    }
});

// --- جلب المحادثات الخاصة بالمستخدم ---
app.get('/api/conversations', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) {
            return c.json({ error: 'غير مصرح' }, 401);
        }

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);
        const userId = payload.sub;

        const db = c.env.DB;
        const { results } = await db.prepare(
            'SELECT id, message, response, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(userId).all();

        return c.json({ conversations: results });

    } catch (error) {
        console.error('Fetch conversations error:', error);
        return c.json({ error: 'فشل في جلب المحادثات' }, 500);
    }
});

export default app;
