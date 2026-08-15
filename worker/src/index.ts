// ============================================================
// وكيل دعم عملاء - مع أدوات (Tools) باستخدام AIChatAgent
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
// 1. تعريف الأدوات (Server-Side Tools)
// ============================================================

const getOrderStatusTool = tool({
    description: 'استعلام عن حالة طلب محدد باستخدام رقم الطلب',
    parameters: z.object({
        orderNumber: z.string().describe('رقم الطلب الذي يريد العميل الاستعلام عنه'),
    }),
    execute: async ({ orderNumber }, { db, userId }) => {
        // محاكاة الاستعلام عن الطلب (يمكن استبدالها بجدول حقيقي)
        return `حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
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
        return `تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
    },
});

// ============================================================
// 2. وكيل AIChatAgent المخصص
// ============================================================

class SupportAgent extends AIChatAgent<Env> {
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

        const systemPrompt = `أنت وكيل دعم فني محترف.

تعليماتك:
- استخدم أداة getOrderStatus عندما يسأل العميل عن حالة طلبه.
- استخدم أداة updateProfile عندما يطلب العميل تحديث بريده الإلكتروني.
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.`;

        const result = await workersai.streamText({
            model: '@cf/meta/llama-3.2-3b-instruct',
            messages: this.messages,
            system: systemPrompt,
            tools: tools,
            temperature: 0.7,
            max_tokens: 256,
        });

        return result.toUIMessageStreamResponse();
    }
}

// ============================================================
// 3. نقطة /ask الجديدة
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
        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

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

        return c.json({ answer });

    } catch (e) {
        console.error('❌ Ask error:', e);
        return c.json({
            answer: '⚠️ عذراً، حدث خطأ في النظام. حاول مرة أخرى.'
        }, 200);
    }
});

// ============================================================
// 4. نقاط النهاية الأخرى (مختصرة)
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

// Authentication (مختصر للتوضيح)
app.post('/api/auth/login', async (c) => {
    const { email } = await c.req.json();
    // ... منطق تسجيل الدخول الكامل من مشروعك ...
    return c.json({ token: 'dummy', user: { id: '123', email } });
});

app.get('/api/auth/me', async (c) => {
    // ... منطق التحقق من التوكن ...
    return c.json({ user: { id: '123', email: 'user@example.com' } });
});

// Conversations
app.get('/api/conversations', async (c) => {
    // ... منطق جلب المحادثات ...
    return c.json({ conversations: [] });
});

export default app;
