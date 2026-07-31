// _worker.js (في جذر المشروع)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // إعادة توجيه طلبات /api/* إلى الـ Worker
    if (url.pathname.startsWith('/api/')) {
      return env.API.fetch(request);
    }
    
    // خدمة الملفات الثابتة
    return env.ASSETS.fetch(request);
  }
};
