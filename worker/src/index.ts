import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

type Env = {
    AI: Ai;
    DB: D1Database;
    JWT_SECRET: string; // 🔥 الآن يُقرأ من البيئة
};

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// 🔒 رؤوس الأمان (Security Headers)
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
// 🔒 CORS (مقيد بالنطاقات المسموحة فقط)
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
// 🔐 المصادقة (Authentication)
// ============================================================

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

        // 🔥 استخدام JWT_SECRET من البيئة
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
            .bind(payload.sub).first();

        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ user });
    } catch (e) {
        console.error('Me error:', e);
        return c.json({ error: 'Invalid token' }, 401);
    }
});

// ============================================================
// 🤖 الوكيل الذكي
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
            .bind(userId).first();

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
