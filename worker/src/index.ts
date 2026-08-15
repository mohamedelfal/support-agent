// ============================================================
// وكيل دعم عملاء - مع أدوات (Tools) باستخدام AIChatAgent
// الإصدار النهائي المتوافق مع أغسطس 2026
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';
import { tool } from 'ai';
import { z } from 'zod';

// ============================================================
// تعريف بيئة العمل (Environment)
// ============================================================
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
// 1. تعريف الأدوات (Server-Side Tools)
// ============================================================

// أداة الاستعلام عن حالة الطلب
const getOrderStatusTool = tool({
    description: 'استعلام عن حالة طلب محدد باستخدام رقم الطلب',
    parameters: z.object({
        orderNumber: z.string().describe('رقم الطلب الذي يريد العميل الاستعلام عنه'),
    }),
    execute: async ({ orderNumber }, { db, userId }) => {
        // محاكاة الاستعلام عن الطلب (يمكن استبدالها بجدول حقيقي)
        return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
    },
});

// أداة تحديث الملف الشخصي
const updateProfileTool = tool({
    description: 'تحديث البريد الإلكتروني للمستخدم',
    parameters: z.object({
        newEmail: z.string().email().describe('البريد الإلكتروني الجديد'),
    }),
    execute: async ({ newEmail }, { db, userId }) => {
        await (db as any).prepare(
            'UPDATE users SET email = ? WHERE id = ?'
        ).bind(newEmail, userId).run();
        return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
    },
});

// ============================================================
// 2. وكيل AIChatAgent المخصص (مع تصدير للكلاس)
// ============================================================

export class SupportAgent extends AIChatAgent<Env> {
    constructor(env: Env, userId: string) {
        super(env);
        this.userId = userId;
    }

    async onChatMessage() {
        const workersai = createWorkersAI({ binding: this.env.AI });

        const tools = {
            getOrderStatus: getOrderStatusTool,
            updateProfile: updateProfileTool,
        };

        const systemPrompt = `أنت وكيل دعم فني محترف في شركة عالمية.

تعليماتك الأساسية:
- استخدم أداة getOrderStatus عندما يسأل العميل عن حالة طلبه.
- استخدم أداة updateProfile عندما يطلب العميل تحديث بريده الإلكتروني.
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.
- لا تكرر نفس الرد مرتين.
- لا تعطِ روابط أو تعليمات غير حقيقية.`;

        const result = await workersai.streamText({
            model: '@cf/meta/llama-3.2-3b-instruct',
            messages: this.messages,
            system: systemPrompt,
            tools: tools,
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

// 3.1 Security Headers
app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
});

// 3.2 CORS
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// 3.3 Health Checks
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

// 3.4 Rate Limiting
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

// 3.5 Authentication - Login
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

// 3.6 Authentication - Me
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

// 3.7 Ask - نقطة السؤال الرئيسية
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
        // البحث عن سياسة في جدول المعرفة (رد مباشر)
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
        // استخدام AIChatAgent للأسئلة العامة
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

        // تنظيف الرد من أي بقايا تنسيقات
        answer = answer.trim();

        // حفظ المحادثة في D1
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

// 3.8 Conversations - جلب المحادثات السابقة
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
