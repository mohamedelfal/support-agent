// functions/api/[[route]].js
export async function onRequest(context) {
  // استدعاء Worker عبر Service Binding (API)
  return context.env.API.fetch(context.request);
}
