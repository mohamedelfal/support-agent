// ============================================================
// وكيل دعم عملاء - مع أدوات (Tools) باستخدام AIChatAgent و streamText
// متوافق مع أحدث وثائق Cloudflare (أغسطس 2026)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';
import { streamText, tool, convertToModelMessages } from 'ai'; // ✅ استيراد convertToModelMessages
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
// 2. وكيل AIChatAgent المخصص (مع التصحيح)
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
- استخدم أداة getOrderStatus عندما يسأل العميل عن حالة طلبه.
- استخدم أداة updateProfile عندما يطلب العميل تحديث بريده الإلكتروني.
- أجب باللغة العربية الفصحى فقط وبإجابة مختصرة وواضحة.
- لا تكرر نفس الرد مرتين.
- لا تعطِ روابط أو تعليمات غير حقيقية.`;

        // ✅ الخطوة الجوهرية: تحويل الرسائل إلى الصيغة المتوقعة
        const messages = await convertToModelMessages(this.messages);

        // ✅ استخدام streamText مع الأدوات والرسائل المحولة
        const result = await streamText({
            model: workersai('@cf/meta/llama-3.2-3b-instruct'),
            messages: messages,
            system: systemPrompt,
            tools: {
                getOrderStatus: getOrderStatusTool,
                updateProfile: updateProfileTool,
            },
            temperature: 0.7,
            max_tokens: 256,
            top_p: 0.9,
        });

        return result.toUIMessageStreamResponse();
    }
}

// ============================================================
// 3. نقاط النهاية (Endpoints)
// ============================================================

// ... (باقي الكود كما هو: CORS, Security, Health, Rate Limiting, Auth, Ask, Conversations)
// تأكد من أن نقطة /ask تستخدم new SupportAgent(c.env, userId) بشكل صحيح.

export default app;
