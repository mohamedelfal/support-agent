// ============================================================
// وكيل الذكاء الاصطناعي - Worker API
// يدعم اللغة العربية وجميع اللغات الأخرى تلقائيًا
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
    AI: Ai;
};

const app = new Hono<{ Bindings: Env }>();

// --- CORS (يسمح لجميع النطاقات بالاتصال) ---
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// --- نقطة الصحة (للتحقق من أن الـ Worker يعمل) ---
app.get('/health', (c) => c.json({ 
    status: 'ok', 
    service: 'AI Agent',
    timestamp: new Date().toISOString()
}));

// --- نقطة اختبار (للتحقق من الاتصال) ---
app.get('/api/test', (c) => c.json({ 
    message: 'API is working!',
    timestamp: new Date().toISOString()
}));

// --- استقبال السؤال وإرجاع الإجابة (يدعم جميع اللغات) ---
app.post('/api/ask', async (c) => {
    try {
        // استخراج السؤال من جسم الطلب
        const { question } = await c.req.json();
        
        // التحقق من وجود سؤال
        if (!question) {
            return c.json({ error: 'السؤال مطلوب' }, 400);
        }

        // الحصول على خدمة الذكاء الاصطناعي من البيئة
        const ai = c.env.AI;
        if (!ai) {
            return c.json({ error: 'AI service not available' }, 503);
        }

        // استدعاء نموذج Mistral-7B (مجاني وسريع)
        const response = await ai.run('@cf/mistral/mistral-7b-instruct-v0.1', {
            messages: [
                { 
                    role: 'system', 
                    content: `أنت مساعد ذكي ومفيد يتحدث جميع اللغات.
                    - اكتشف لغة سؤال المستخدم وأجب بنفس اللغة.
                    - إذا كان السؤال بالعربية، أجب بالعربية الفصحى الواضحة.
                    - إذا كان السؤال بالإنجليزية، أجب بالإنجليزية.
                    - إذا كان السؤال بلغة أخرى، أجب بنفس اللغة إن أمكن، وإلا استخدم الإنجليزية.
                    - كن دقيقًا ومفيدًا في جميع إجاباتك.
                    - إذا لم تعرف الإجابة، قل ذلك بوضوح دون اختلاق معلومات.`
                },
                { role: 'user', content: question }
            ],
            temperature: 0.3,      // تحكم في الإبداع (0 = دقيق، 1 = إبداعي)
            max_tokens: 500,       // الحد الأقصى لطول الإجابة
        });

        // إرجاع الإجابة
        return c.json({ 
            answer: response.response || 'لم أستطع الإجابة على هذا السؤال.' 
        });

    } catch (error) {
        // تسجيل الخطأ في سجلات الـ Worker
        console.error('AI Error:', error);
        
        // إرجاع رسالة خطأ واضحة للمستخدم
        return c.json({ 
            error: 'حدث خطأ أثناء معالجة الطلب' 
        }, 500);
    }
});

export default app;
