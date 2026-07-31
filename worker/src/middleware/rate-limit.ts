// worker/src/middleware/rate-limit.ts
import { Context } from 'hono';

const RATE_LIMIT = 50;
const WINDOW_SECONDS = 60;

export async function rateLimitMiddleware(c: Context, next: () => Promise<void>) {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const userId = user.sub;
  const limiter = c.env.RATE_LIMITER;
  const obj = limiter.get(limiter.idFromName(userId));

  try {
    const state = await obj.getState();
    const now = Math.floor(Date.now() / 1000);
    const windowStart = state.windowStart || now;
    const count = state.count || 0;

    if (now - windowStart > WINDOW_SECONDS) {
      await obj.setState({ windowStart: now, count: 1 });
      await next();
      return;
    }

    if (count >= RATE_LIMIT) {
      return c.json({
        error: 'Too many requests',
        retryAfter: WINDOW_SECONDS - (now - windowStart)
      }, 429);
    }

    await obj.setState({ windowStart, count: count + 1 });
    await next();
  } catch (e) {
    await next();
  }
}
