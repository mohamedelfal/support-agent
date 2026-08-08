export interface Env {
  AI: any;
  DB: D1Database;
  CACHE_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // معالجة طلبات الاستكشاف Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // 1. نقطة فحص سلامة السيرفر (Health Check)
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({ status: 'online', engine: 'Cloudflare Workers AI', timestamp: new Date() }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // 2. نقطة محادثة الوكيل الذكي (Chat Endpoint)
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const body: any = await request.json().catch(() => null);

        if (!body || !body.sessionId || !body.message) {
          return new Response(
            JSON.stringify({ error: 'يرجى إرسال sessionId و message' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { sessionId, message } = body;

        // استرجاع آخر 6 رسائل لبناء سياق المحادثة من قاعدة البيانات
        const { results: history } = await env.DB.prepare(
          `SELECT role, content FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT 6`
        ).bind(sessionId).all();

        const conversationHistory = history ? history.reverse() : [];

        // تعليمات النظام الذكية للوكيل
        const systemPrompt = `أنت وكيل ذكي مخصص لدعم العملاء والمبيعات، تتحدث باللغة العربية بأسلوب راقٍ ومباشر.
مهامك الرئيسية:
1. الإجابة عن استفسارات العملاء بدقة وإيجاز.
2. في حال طلب العميل التواصل أو الشراء، اطلب منه الاسم ورقم الهاتف بلطف.
3. كن متعاطفاً وسريع الرد ولا تذكر أي تفاصيل تقنية داخلية.`;

        const messages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.map((h: any) => ({ role: h.role, content: h.content })),
          { role: 'user', content: message }
        ];

        // استدعاء النموذج المجاني والسريع من Cloudflare Workers AI
        const aiResponse: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages,
          max_tokens: 512,
          temperature: 0.6,
        });

        const reply = aiResponse.response || 'أهلاً بك! كيف يمكنني مساعدتك اليوم؟';

        // حفظ المحادثة في الخلفية لضمان السرعة (Non-blocking Background Processing)
        ctx.waitUntil(
          (async () => {
            try {
              await env.DB.prepare(
                `INSERT INTO conversations (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)`
              ).bind(sessionId, message, sessionId, reply).run();
            } catch (err) {
              console.error('D1 Storage Error:', err);
            }
          })()
        );

        return new Response(
          JSON.stringify({ success: true, reply }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ error: 'المسار المطلوب غير موجود' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (error: any) {
      console.error('Runtime Error:', error);
      return new Response(
        JSON.stringify({ error: 'حدث خطأ في السيرفر', details: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
