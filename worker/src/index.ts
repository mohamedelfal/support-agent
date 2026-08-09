// ============================================================
// وكيل الذكاء الاصطناعي - Worker API (نسخة متطورة)
// النموذج: Qwen3-30B-A3B (دعم ممتاز للغة العربية)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
    AI: Ai;
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

// --- استقبال السؤال وإرجاع الإجابة ---
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

        // استخدام نموذج Qwen3-30B (أقوى وأدق)
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
            temperature: 0.2,      // دقة عالية
            max_tokens: 800,       // إجابات أطول وأكثر تفصيلاً
        });

        return c.json({ 
            answer: response.response || 'لم أستطع الإجابة على هذا السؤال.' 
        });

    } catch (error) {
        console.error('AI Error:', error);
        return c.json({ 
            error: 'حدث خطأ أثناء معالجة الطلب' 
        }, 500);
    }
});

export default app;
