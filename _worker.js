// _worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // إعادة توجيه طلبات /api/* إلى Worker
    if (url.pathname.startsWith('/api/')) {
      try {
        // إضافة CORS Headers للرد
        const response = await env.API_WORKER.fetch(request);
        const newResponse = new Response(response.body, response);
        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return newResponse;
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Worker error: ' + error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // خدمة الملفات الثابتة
    return env.ASSETS.fetch(request);
  }
};
