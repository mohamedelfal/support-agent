// ============================================================
// وكيل الذكاء الاصطناعي - Worker API
// مع دعم قاعدة البيانات D1 (حفظ واسترجاع المحادثات)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
    AI: Ai;
    DB: D1Database;
};

const app = new Hono<{ Bindings: Env }>();

// --- CORS ---
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// --- نقطة الصحة ---
app.get('/health', (c) => c.json({ 
    status: 'ok', 
    service: 'AI Agent (Qwen3-30B)',
    timestamp: new Date().toISOString()
}));

// --- نقطة اختبار ---
app.get('/api/test', (c) => c.json({ 
    message: 'API is working!',
    timestamp: new Date().toISOString()
}));

// --- استقبال السؤال وإرجاع الإجابة (مع حفظ في D1) ---
app.post('/api/ask', async (c) => {
    try {
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

        // حفظ المحادثة في D1
        await db.prepare(
            `INSERT INTO conversations (id, message, response, created_at) VALUES (?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(),
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

// --- جلب المحادثات السابقة ---
app.get('/api/conversations', async (c) => {
    try {
        const db = c.env.DB;
        const { results } = await db.prepare(
            'SELECT id, message, response, created_at FROM conversations ORDER BY created_at DESC LIMIT 50'
        ).all();
        return c.json({ conversations: results });
    } catch (error) {
        console.error('Fetch conversations error:', error);
        return c.json({ error: 'فشل في جلب المحادثات' }, 500);
    }
});

export default app;
