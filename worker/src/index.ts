// ============================================================
// وكيل دعم عملاء - مع ذاكرة قصيرة وطويلة المدى
// يجمع بين الكود الأصلي و AIChatAgent و Agent Memory
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { AIChatAgent } from '@cloudflare/ai-chat';
import { createWorkersAI } from 'workers-ai-provider';

type Env = {
    AI: Ai;
    DB: D1Database;
    JWT_SECRET: string;
    RATE_LIMIT_KV: KVNamespace;
    AI_GATEWAY_ID: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    MEMORY: AgentMemoryNamespace; // Binding الذاكرة الجديد
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
// 🤖 وكيل AIChatAgent المخصص (مع الذاكرة)
// ============================================================
class SupportAgent extends AIChatAgent<Env> {
    // تمرير userId من السياق
    constructor(env: Env, userId: string) {
        super(env);
        this.userId = userId; // يُستخدم لتحديد جلسة المحادثة
    }

    async onChatMessage() {
        const workersai = createWorkersAI({ binding: this.env.AI });

        // الحصول على ملف تعريف المستخدم من الذاكرة طويلة المدى
        // نستخدم userId كـ profileName للتمييز بين المستخدمين
        const profile = this.env.MEMORY.getProfile(this.userId);

        // 1. استرجاع ذكريات سابقة متعلقة بالسؤال
        let memoryContext = '';
        try {
            const lastMessage = this.messages[this.messages.length - 1];
            if (lastMessage && lastMessage.content) {
                const recallResult = await profile.recall(lastMessage.content);
                if (recallResult && recallResult.answer) {
                    memoryContext = `\n\nمعلومات من ذاكرة المحادثات السابقة: ${recallResult.answer}`;
                }
            }
        } catch (e) {
            console.error('خطأ في استرجاع الذاكرة:', e);
        }

        // 2. System Prompt القصير (سطر واحد) مع سياق الذاكرة
        const systemPrompt = `أنت وكيل دعم فني. أجب بالعربية الفصحى فقط وبإجابة مختصرة (جملتين كحد أقصى). استخدم المعلومات التالية من ذاكرة العميل إذا كانت مفيدة: ${memoryContext}`;

        // 3. استدعاء النموذج مع تاريخ المحادثة الكامل (this.messages)
        const result = await workersai.streamText({
            model: '@cf/meta/llama-3.2-3b-instruct',
            messages: this.messages,
            system: systemPrompt,
            temperature: 0.3,
            max_tokens: 256,
        });

        // 4. حفظ الذكريات الجديدة تلقائياً (بعد انتهاء الرد)
        try {
            const lastMessage = this.messages[this.messages.length - 1];
            if (lastMessage && lastMessage.content) {
                await profile.ingest([
                    { role: 'user', content: lastMessage.content }
                ]);
                // يمكن إضافة رد الوكيل أيضاً إذا رغبت
                // لكن ingest() تستخرج الذكريات تلقائياً من المحادثة
            }
        } catch (e) {
            console.error('خطأ في حفظ الذاكرة:', e);
        }

        return result.toUIMessageStreamResponse();
    }
}

// ============================================================
// نقطة /ask المعدلة لاستخدام AIChatAgent
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

        // ============================================================
        // 1. البحث في المعرفة (للسياسات) - نفس الكود القديم
        // ============================================================
        const { question } = await c.req.json();
        if (!question) return c.json({ error: 'Question required' }, 400);

        const MAX_QUESTION_LENGTH = 1000;
        if (question.length > MAX_QUESTION_LENGTH) {
            return c.json({
                error: `Question is too long. Maximum ${MAX_QUESTION_LENGTH} characters allowed.`,
            }, 400);
        }

        // نبحث في جدول knowledge عن تطابق للسياسات
        const words = question.split(' ').filter(w => w.length > 2);
        let knowledgeAnswer = '';
        let foundKnowledge = false;

        for (const word of words) {
            const knowledgeResults = await c.env.DB.prepare(
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

        // إذا وجدنا سياسة، نرد مباشرة (بدون AIChatAgent)
        if (foundKnowledge) {
            await c.env.DB.prepare(
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
        // 2. للأسئلة العامة: استخدام AIChatAgent مع الذاكرة
        // ============================================================
        const agent = new SupportAgent(c.env, userId);
        
        // نقوم بمحاكاة طلب WebSocket لـ AIChatAgent
        // نحتاج إلى تمرير الرسالة كـ Request
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

        // حفظ المحادثة في D1 (للتاريخ)
        await c.env.DB.prepare(
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

// ============================================================
// 📜 جلب المحادثات السابقة (نفس الكود القديم)
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
