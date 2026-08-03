// ============================================================
// نقطة الدخول الرئيسية
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import { Env } from './types';
import {
  correlationIdMiddleware,
  securityHeaders,
  authMiddleware,
  rateLimitMiddleware,
  csrfMiddleware,
  idempotencyMiddleware,
  requestValidationMiddleware,
  validateEnvironment,
} from './middleware';

import authRoutes from './routes/auth';
import ticketsRoutes from './routes/tickets';
import chatRoutes from './routes/chat';
import healthRoutes from './routes/health';

// --- استيراد Durable Objects ---
import { RefreshFamily } from './durable/refresh-family';
import { CircuitBreaker } from './durable/circuit-breaker';
import { RateLimiter } from './durable/rate-limiter';

export { RefreshFamily, CircuitBreaker, RateLimiter };

const app = new Hono<{ Bindings: Env }>();

// --- CORS (للسماح للواجهة بالاتصال) ---
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key'],
  credentials: true,
  maxAge: 86400,
}));

// --- Validate Environment ---
app.use('*', async (c, next) => {
  const validation = validateEnvironment(c.env);
  if (!validation.valid) {
    return c.json({ error: 'Configuration error: ' + validation.error }, 500);
  }
  await next();
});

// --- Global Middleware ---
app.use('*', correlationIdMiddleware);
app.use('*', securityHeaders);
app.use('*', requestValidationMiddleware);

// --- Health ---
app.route('/health', healthRoutes);

// --- Auth (public) ---
app.route('/api/v1/auth', authRoutes);

// --- Protected Routes ---
app.use('/api/v1/*', rateLimitMiddleware);
app.use('/api/v1/*', csrfMiddleware);
app.use('/api/v1/*', idempotencyMiddleware);
app.use('/api/v1/*', authMiddleware);

app.route('/api/v1/tickets', ticketsRoutes);
app.route('/api/v1/chat', chatRoutes);

// --- خدمة الملفات الثابتة (الواجهة الأمامية) ---
app.get('/*', serveStatic({
  root: '../frontend',
  rewriteRequestPath: (path) => {
    // إذا كان الطلب على `/index.html` أو `/`، نخدم `index.html`
    if (path === '/' || path === '/index.html') {
      return '/index.html';
    }
    return path;
  },
}));

export default app;
