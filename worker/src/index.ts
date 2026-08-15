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

const getOrderStatusTool = tool({
    description: 'استعلام عن حالة طلب محدد باستخدام رقم الطلب',
    parameters: z.object({
        orderNumber: z.string().describe('رقم الطلب الذي يريد العميل الاستعلام عنه'),
    }),
    execute: async ({ orderNumber }, { db, userId }) => {
        return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
    },
});

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
// 2. وكيل AIChatAgent المخصص
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
// 3. نقاط النهاية (Endpoints) - مختصرة للتوضيح
// ============================================================

// CORS
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

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

// Authentication - Login (مختصر)
app.post('/api/auth/login', async (c) => {
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
        c.env.JWT_SECRET, 'HS256'
    );
    return c.json({ success: true, token, user: { id: user.id, email: user.email } });
});

// Authentication - Me
app.get('/api/auth/me', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
        if (!payload.sub) return c.json({ error: 'Invalid token payload' }, 401);
        const db = c.env.DB;
        const user = await db.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
            .bind(payload.sub).first();
        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ user });
    } catch { return c.json({ error: 'Invalid token' }, 401); }
});

// Ask - نقطة السؤال الرئيسية
app.post('/api/ask', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
        if (!payload.sub) return c.json({ error: 'Invalid token payload' }, 401);
        const userId = payload.sub;
        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
        if (!user) return c.json({ error: 'User not found' }, 404);
        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);
        if (question.length > 1000) return c.json({ error: 'Question too long' }, 400);

        // البحث عن سياسة في جدول المعرفة
        const words = question.split(' ').filter(w => w.length > 2);
        let knowledgeAnswer = '';
        let foundKnowledge = false;
        for (const word of words) {
            const knowledgeResults = await db.prepare(
                `SELECT answer FROM knowledge WHERE question LIKE ? OR keywords LIKE ? LIMIT 1`
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
            ).bind(crypto.randomUUID(), userId, question, knowledgeAnswer, new Date().toISOString()).run();
            return c.json({ answer: knowledgeAnswer });
        }

        // استخدام AIChatAgent للأسئلة العامة
        const agent = new SupportAgent(c.env, userId);
        const body = JSON.stringify({ messages: [{ role: 'user', content: question }] });
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
        ).bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString()).run();
        return c.json({ answer });
    } catch (e) {
        console.error('❌ Ask error:', e);
        return c.json({ answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.' }, 200);
    }
});

// Conversations - جلب المحادثات السابقة
app.get('/api/conversations', async (c) => {
    try {
        const auth = c.req.header('Authorization');
        if (!auth) return c.json({ error: 'Unauthorized' }, 401);
        const token = auth.replace('Bearer ', '');
        const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
        if (!payload.sub) return c.json({ error: 'Invalid token payload' }, 401);
        const userId = payload.sub;
        const db = c.env.DB;
        const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
        if (!user) return c.json({ error: 'User not found' }, 404);
        const { results } = await db.prepare(
            'SELECT id, message, response, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(userId).all();
        return c.json({ conversations: results });
    } catch { return c.json({ error: 'Failed to fetch conversations' }, 500); }
});

export default app;
