import { Hono } from 'hono';
import { Env } from '../types';

const startTime = Date.now();
const app = new Hono<{ Bindings: Env }>();

app.get('/live', (c) => c.json({ status: 'alive', uptime: Date.now() - startTime }));

app.get('/ready', async (c) => {
  try {
    const db = c.env.DB;
    const result = await db.prepare('SELECT COUNT(*) as count FROM users').first();
    if (result === undefined || result === null) {
      throw new Error('Database unavailable');
    }
    await c.env.CACHE_KV.get('health');
    const limiter = c.env.RATE_LIMITER;
    const obj = limiter.get(limiter.idFromName('health'));
    await obj.fetch('https://internal/health');
    return c.json({ status: 'ready' });
  } catch (error) {
    return c.json({ status: 'not ready', error: (error as Error).message }, 503);
  }
});

app.get('/startup', (c) => c.json({
  status: 'started',
  version: '3.1.0',
  environment: c.env.ENVIRONMENT,
  authMode: c.env.AUTH_MODE,
}));

export default app;
