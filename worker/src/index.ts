// ============================================================
// وكيل الذكاء الاصطناعي - Worker API
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
    AI: Ai; // Workers AI binding
};

const app = new Hono<{ Bindings: Env }>();

// --- CORS (للسماح لـ Pages بالاتصال) ---
app.use('*', cors({
    origin: ['https://support-agent.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// --- نقطة الصحة ---
app.get('/health', (c) => c.json({ status: 'ok', service: 'AI Agent' }));

// --- استقبال السؤال وإرجاع الإجابة ---
app.post('/api/ask', async (c) => {
    try {
        const { question } = await c.req.json();
        if (!question) {
            return c.json({ error: 'السؤال مطلوب' }, 400);
        }

        // استدعاء Workers AI
        const ai = c.env.AI;
        const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                { role: 'system', content: 'أنت مساعد ذكي ومفيد. أجب على الأسئلة بوضوح ودقة.' },
                { role: 'user', content: question }
            ],
            temperature: 0.3,
            max_tokens: 500,
        });

        return c.json({ answer: response.response });

    } catch (error) {
        console.error('AI Error:', error);
        return c.json({ error: 'حدث خطأ أثناء معالجة الطلب' }, 500);
    }
});

export default app;
