// _worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // إذا كان الطلب إلى /api/*، أرسله إلى Worker عبر Service Binding
    if (url.pathname.startsWith('/api/')) {
      return env.API_WORKER.fetch(request);
    }
    
    // وإلا، خدمة الملفات الثابتة
    return env.ASSETS.fetch(request);
  }
};
