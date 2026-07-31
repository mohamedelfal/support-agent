// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rate-limit';
import auth from './routes/auth';
import tickets from './routes/tickets';
import chat from './routes/chat';

// ⬇️ أضف هذين السطرين ⬇️
import { RateLimiter } from './durable/rate-limiter';
export { RateLimiter };

type Env = {
  DB: D1Database;
  AI_GATEWAY: any;
  AI: any;
  RATE_LIMITER: DurableObjectNamespace;
  JWT_SECRET: string;
  AI_GATEWAY_ID: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: ['https://your-domain.pages.dev', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.get('/', (c) => c.json({
  status: 'ok',
  service: 'Support Agent',
  version: '1.0.0'
}));

app.route('/api/auth', auth);
app.use('/api/*', authMiddleware);
app.use('/api/*', rateLimitMiddleware);
app.route('/api/tickets', tickets);
app.route('/api/chat', chat);

export default app;
