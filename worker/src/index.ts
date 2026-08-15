// ============================================================
// وكيل دعم عملاء - مع كشف مباشر للأدوات (بدون Function Calling)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';
import { tool } from 'ai';
import { z } from 'zod';

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
// 1. تعريف الأدوات (كدوال عادية)
// ============================================================

async function getOrderStatus(db: D1Database, userId: string, orderNumber: string): Promise<string> {
    // محاكاة الاستعلام عن الطلب (يمكن استبدالها بجدول حقيقي)
    return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

async function updateProfile(db: D1Database, userId: string, newEmail: string): Promise<string> {
    await db.prepare(
        'UPDATE users SET email = ? WHERE id = ?'
    ).bind(newEmail, userId).run();
    return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
}

// ============================================================
// 2. وكيل AIChatAgent (للأسئلة العامة فقط)
// ============================================================

export class SupportAgent extends AIChatAgent<Env> {
    constructor(env: Env, userId: string) {
        super(env);
        this.userId = userId;
    }

    async onChatMessage() {
        const workersai = createWorkersAI({ binding: this.env.AI });

        const systemPrompt = `أنت وكيل دعم فني محترف في شركة عالمية.

تعليماتك الأساسية:
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.
- لا تكرر نفس الرد مرتين.
- لا تعطِ روابط أو تعليمات غير حقيقية.`;

        const result = await workersai.streamText({
            model: '@cf/meta/llama-3.2-3b-instruct',
            messages: this.messages,
            system: systemPrompt,
            temperature: 0.7,
            max_tokens: 256,
            top_p: 0.9,
            repetition_penalty: 1.1,
        });

        return result.toUIMessageStreamResponse();
    }
}

// ============================================================
// 3. نقاط النهاية (Endpoints)
// ============================================================

// CORS
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// Security Headers
app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
});

// Health Checks
app.get('/health/live', (c) => c.json({ status: 'alive' }));
app.get('/health/ready', async (c) => {
    try {
        await c.env.DB.prepare('SELECT 1').first();
        return c.json({ status: 'ready' });
    } catch {
        return c.json({ status: 'unhealthy' }, 503);
    }
});

// Rate Limiting
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

// Authentication - Login
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

// Authentication - Me
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
// 3. نقطة /ask (مع كشف مباشر للأدوات)
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
        // 🔥 الخطوة 1: كشف مباشر للأدوات (بدون Function Calling)
        // ============================================================

        // 1.1 الكشف عن رقم الطلب في السؤال
        const orderMatch = question.match(/\b(\d{4,})\b/);
        const isOrderQuery = question.includes('حالة طلبي') || question.includes('الطلب') || question.includes('شحنتي') || question.includes('تتبع');
        
        if (orderMatch && isOrderQuery) {
            const orderNumber = orderMatch[1];
            const result = await getOrderStatus(db, userId, orderNumber);
            
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

        // 1.2 الكشف عن تحديث البريد الإلكتروني
        const emailMatch = question.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const isUpdateProfile = question.includes('تحديث بريدي') || question.includes('غير إيميل') || question.includes('تغيير الإيميل') || question.includes('تغيير البريد');
        
        if (emailMatch && isUpdateProfile) {
            const newEmail = emailMatch[0];
            const result = await updateProfile(db, userId, newEmail);
            
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
        // 🔥 الخطوة 2: البحث عن سياسة في جدول المعرفة
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
        // 🔥 الخطوة 3: الأسئلة العامة (استخدام AIChatAgent)
        // ============================================================
        const agent = new SupportAgent(c.env, userId);

        const body = JSON.stringify({
            messages: [{ role: 'user', content: question }]
        });
        const request = new Request('https://agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });

        const response = await agent.fetch(request);
        const data = await response.json();

        let answer = data?.messages?.[data.messages.length - 1]?.content || 'عذراً، لم أستطع معالجة طلبك.';
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

// Conversations - جلب المحادثات السابقة
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
