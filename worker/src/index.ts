// ============================================================
// وكيل دعم عملاء - مع أدوات (Tools) باستخدام AIChatAgent
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
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

// أداة الاستعلام عن حالة الطلب
const getOrderStatusTool = tool({
    description: 'استعلام عن حالة طلب محدد باستخدام رقم الطلب',
    parameters: z.object({
        orderNumber: z.string().describe('رقم الطلب الذي يريد العميل الاستعلام عنه'),
    }),
    execute: async ({ orderNumber }, { db, userId }) => {
        // محاكاة الاستعلام عن الطلب من قاعدة البيانات
        // في التطوير الفعلي، يتم استبدال هذا بكود حقيقي للاستعلام عن الطلبات
        const order = await (db as any).prepare(
            'SELECT status, tracking_number FROM orders WHERE id = ? AND user_id = ?'
        ).bind(orderNumber, userId).first();

        if (order) {
            return `حالة الطلب رقم ${orderNumber}: ${order.status}. رقم التتبع: ${order.tracking_number}`;
        } else {
            return `لم يتم العثور على طلب برقم ${orderNumber}. يرجى التأكد من الرقم والمحاولة مرة أخرى.`;
        }
    },
});

// أداة إنشاء تذكرة دعم جديدة (مع منطق التأكيد)
const createTicketTool = tool({
    description: 'إنشاء تذكرة دعم جديدة لمشكلة يواجهها العميل',
    parameters: z.object({
        issue: z.string().describe('وصف المشكلة التي يواجهها العميل'),
    }),
    // لن نقوم بتنفيذ execute هنا، بل سنستخدمها كـ Client-Side Tool
    // لتأكيد المستخدم قبل الإنشاء
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
        return `تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
    },
});

// ============================================================
// 2. وكيل AIChatAgent المخصص
// ============================================================

class SupportAgent extends AIChatAgent<Env> {
    // تمرير userId من السياق
    constructor(env: Env, userId: string) {
        super(env);
        this.userId = userId;
    }

    async onChatMessage() {
        // دمج الأدوات في كائن واحد
        const tools = {
            getOrderStatus: getOrderStatusTool,
            updateProfile: updateProfileTool,
            // createTicketTool سيتم التعامل معها كـ Client-Side Tool
        };

        // نظام التعليمات (System Prompt) المبسط
        const systemPrompt = `أنت وكيل دعم فني محترف.

تعليماتك:
- استخدم أداة getOrderStatus عندما يسأل العميل عن حالة طلبه.
- استخدم أداة updateProfile عندما يطلب العميل تحديث بريده الإلكتروني.
- عندما يطلب العميل إنشاء تذكرة دعم، أخبره أنك ستقوم بإنشائها بعد تأكيده.
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.`;

        // استدعاء النموذج مع الأدوات
        const result = await this.ai.streamText({
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

        // إنشاء وكيل جديد لكل طلب
        const agent = new SupportAgent(c.env, userId);

        // محاكاة طلب WebSocket لـ AIChatAgent
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

        // استخراج الرد من response
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
// 4. نقاط النهاية الأخرى (نفس الكود السابق)
// ============================================================

// ... (نقاط النهاية الخاصة بـ Security, CORS, Health, Auth, و Conversations تبقى كما هي)

export default app;
