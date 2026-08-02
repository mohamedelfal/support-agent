
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const validation = validateEnvironment(c.env);
  if (!validation.valid) {
    return c.json({ error: 'Configuration error: ' + validation.error }, 500);
  }
  await next();
});

app.use('*', correlationIdMiddleware);
app.use('*', securityHeaders);
app.use('*', requestValidationMiddleware);
app.use('*', cors({
  origin: ['https://support-agent.pages.dev', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key'],
  credentials: true,
  maxAge: 86400,
}));

app.route('/health', healthRoutes);
app.route('/api/v1/auth', authRoutes);

app.use('/api/v1/*', rateLimitMiddleware);
app.use('/api/v1/*', csrfMiddleware);
app.use('/api/v1/*', idempotencyMiddleware);
app.use('/api/v1/*', authMiddleware);

app.route('/api/v1/tickets', ticketsRoutes);
app.route('/api/v1/chat', chatRoutes);

export default app;
