import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Env = {
    AI: Ai;
    DB: D1Database;
    JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (c) => c.json({ status: 'ok', service: 'AI Agent' }));

// --- تسجيل الدخول ---
app.post('/api/auth/login', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) return c.json({ error: 'Email required' }, 400);

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
            c.env.JWT_SECRET
        );

        return c.json({ success: true, token, user: { id: user.id, email: user.email } });
    } catch (e) {
        console.error('Login error:', e);
        return c.json({ error: 'Login failed' }, 500);
    }
});

// --- التحقق من الجلسة ---
app.get('/api/auth/me', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);

        const db = c.env.DB;
        const user = await db.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
            .bind(payload.sub).first();

        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ user });
    } catch (e) {
        return c.json({ error: 'Invalid token' }, 401);
    }
});

// --- السؤال والإجابة (مع تصحيح user_id) ---
app.post('/api/ask', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);

        // 🔥 التصحيح: استخدم payload.sub مباشرةً (لا حاجة لاستعلام إضافي)
        const userId = payload.sub;

        // تحقق من وجود المستخدم في قاعدة البيانات (للتأكد)
        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?')
            .bind(userId).first();

        if (!user) {
            console.error('User not found in DB:', userId);
            return c.json({ error: 'User not found in database' }, 404);
        }

        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

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

        // 🔥 تأكد من أن userId ليس null أو undefined
        if (!userId) {
            console.error('userId is null or undefined');
            return c.json({ error: 'Invalid user ID' }, 400);
        }

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
        console.error('Error in /api/ask:', e);
        return c.json({ error: 'Internal error' }, 500);
    }
});

// --- جلب المحادثات (مع تصحيح user_id) ---
app.get('/api/conversations', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);

        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET);

        // 🔥 استخدم payload.sub مباشرةً
        const userId = payload.sub;

        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?')
            .bind(userId).first();

        if (!user) {
            console.error('User not found in DB:', userId);
            return c.json({ error: 'User not found' }, 404);
        }

        const { results } = await db.prepare(
            'SELECT id, message, response, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(userId).all();

        return c.json({ conversations: results });
    } catch (e) {
        console.error('Error in /api/conversations:', e);
        return c.json({ error: 'Failed to fetch conversations' }, 500);
    }
});

export default app;
