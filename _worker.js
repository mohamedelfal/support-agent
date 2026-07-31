export default {
  async fetch(request, env) {
    // إعادة توجيه جميع طلبات /api/* إلى الـ Worker
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // استدعاء Worker عبر Service Binding
      return env.API.fetch(request);
    }
    // خلاف ذلك، خدمة الملفات الثابتة
    return env.ASSETS.fetch(request);
  }
};
