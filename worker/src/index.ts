// ============================================================
// وكيل دعم عملاء - الإصدار النهائي (Llama 3.2 3B)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';

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
// Security Headers
// ============================================================
app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
});

// ============================================================
// CORS
// ============================================================
app.use('*', cors({
    origin: ['https://support-agent-dxu.pages.dev', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ============================================================
// Health Checks
// ============================================================
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

// ============================================================
// Rate Limiting
// ============================================================
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

// ============================================================
// Authentication
// ============================================================
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
// 🤖 الوكيل الذكي - الإصدار النهائي (Llama 3.2 3B)
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
        // 1. جلب آخر 5 محادثات للسياق
        // ============================================================
        const { results: history } = await db.prepare(
            `SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
        ).bind(userId).all();

        let contextText = '';
        if (history && history.length > 0) {
            const reversed = history.reverse();
            contextText = 'المحادثات السابقة مع هذا العميل:\n';
            for (const record of reversed) {
                contextText += `- سؤال: ${record.message}\n- رد: ${record.response}\n`;
            }
        }

        // ============================================================
        // 2. البحث في المعرفة (فقط للأسئلة التي قد تتعلق بالسياسات)
        // ============================================================
        const policyKeywords = ['شحن', 'توصيل', 'استرجاع', 'مرتجع', 'كلمة السر', 'باسورد', 'حساب', 'دفع', 'كارت', 'تحويل', 'سياسة'];
        const isPolicyQuestion = policyKeywords.some(keyword => question.includes(keyword));

        let knowledgeText = '';
        let foundKnowledge = false;

        if (isPolicyQuestion) {
            const words = question.split(' ').filter(w => w.length > 2);
            for (const word of words) {
                const knowledgeResults = await db.prepare(
                    `SELECT question, answer FROM knowledge 
                     WHERE question LIKE ? OR keywords LIKE ? 
                     LIMIT 1`
                ).bind(`%${word}%`, `%${word}%`).all();

                if (knowledgeResults.results && knowledgeResults.results.length > 0) {
                    const k = knowledgeResults.results[0];
                    knowledgeText = `معلومة رسمية من سياسة الشركة:\nسؤال: ${k.question}\nجواب: ${k.answer}`;
                    foundKnowledge = true;
                    break;
                }
            }
        }

        // ============================================================
        // 3. بناء System Prompt مع تعليمات دقيقة للمعرفة العامة
        // ============================================================
        let systemPrompt = '';

        if (foundKnowledge) {
            systemPrompt = `أنت وكيل دعم عملاء محترف في شركة عالمية.

**تعليماتك الأساسية:**
- استخدم المعلومة الرسمية من سياسة الشركة المقدمة لك في ردك.
- يمكنك إعادة صياغة المعلومة بأسلوبك الخاص مع الحفاظ على المعنى الدقيق.
- لا تذكر عبارة "من سياسة الشركة" في ردك، بل ادمج المعلومة بشكل طبيعي.
- إذا كان السؤال يحتوي على جوانب إضافية خارج المعلومة، يمكنك الإجابة من معرفتك العامة.
- رد دائماً باللغة العربية الفصحى بأسلوب مهذب وواضح ومفصل.

${knowledgeText}

${contextText ? `\n${contextText}` : ''}

سؤال العميل: ${question}`;
        } else {
            systemPrompt = `أنت وكيل دعم عملاء محترف في شركة عالمية، ولديك معرفة واسعة في جميع المجالات.

**تعليماتك:**
- أجب على سؤال العميل بأفضل ما لديك من معرفة عامة ودقيقة.
- قدم إجابات شاملة ومفصلة، مع شرح المصطلحات والمفاهيم عند الحاجة.
- إذا كان السؤال يتعلق بسياسات الشركة (مثل الشحن، الاسترجاع، الحساب) ولا تعرف الإجابة الدقيقة، اعتذر واطلب من العميل التواصل مع الدعم البشري.
- بالنسبة للأسئلة العامة والتقنية، أجب بحرية من معرفتك مع الحرص على الدقة.
- إذا كان السؤال غير واضح، اطلب توضيحاً بأسلوب مهذب.
- رد دائماً باللغة العربية الفصحى بأسلوب مهذب وواضح ومفصل.

${contextText ? `\n${contextText}` : ''}

سؤال العميل: ${question}`;
        }

        // ============================================================
        // 4. استدعاء النموذج (Llama 3.2 3B - التوازن المثالي)
        // ============================================================
        let response;
        try {
            response = await c.env.AI.run(
                '@cf/meta/llama-3.2-3b-instruct', // ✅ نموذج 3B المتوازن
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: question }
                    ],
                    temperature: 0.7,          // ✅ أعلى قليلاً للإبداع والدقة
                    max_tokens: 1024,          // ✅ زيادة الرموز للإجابات المفصلة
                    top_p: 0.95,               // ✅ أفضل ممارسة لـ Top-P
                    repetition_penalty: 1.15,  // ✅ منع التكرار بقوة معتدلة
                    frequency_penalty: 0.6,    // ✅ تقليل تكرار الكلمات
                    presence_penalty: 0.3,     // ✅ تشجيع التنوع في الموضوعات
                }
            );
        } catch (aiError) {
            const errorMsg = (aiError as Error).message || 'خطأ غير معروف';
            console.error('❌ AI Error:', errorMsg);
            return c.json({ 
                answer: `⚠️ عذراً، حدث خطأ في الذكاء الاصطناعي. يرجى المحاولة مرة أخرى.` 
            }, 200);
        }

        // ============================================================
        // 5. استخراج الرد وتنظيفه
        // ============================================================
        let answer = 
            response?.response ||
            response?.choices?.[0]?.message?.content ||
            response?.result?.response ||
            response?.output?.text ||
            response?.content ||
            response?.text ||
            response?.message?.content ||
            null;

        if (!answer) {
            answer = '⚠️ عذراً، لم أستطع معالجة طلبك حالياً. حاول مرة أخرى.';
        }

        // تنظيف الرد من أي بقايا تنسيقات
        answer = answer.replace(/\*\*الوكيل:\*\*/g, '').replace(/\*\*العميل:\*\*/g, '');
        answer = answer.replace(/الوكيل:/g, '').replace(/العميل:/g, '');
        answer = answer.trim();

        // ============================================================
        // 6. حفظ المحادثة
        // ============================================================
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
            answer: '⚠️ عذراً، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' 
        }, 200);
    }
});

// ============================================================
// 📜 جلب المحادثات السابقة
// ============================================================
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
