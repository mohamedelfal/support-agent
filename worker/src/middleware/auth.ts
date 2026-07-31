// worker/src/middleware/auth.ts
import { Context } from 'hono';
import { verify } from 'hono/jwt';

export async function authMiddleware(c: Context, next: () => Promise<void>) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = await verify(token, c.env.JWT_SECRET);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ error: 'Unauthorized: Token expired' }, 401);
    }
    c.set('user', payload);
    await next();
  } catch (e) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
}

export function getUserId(c: Context): string {
  const user = c.get('user');
  if (!user || !user.sub) throw new Error('User not authenticated');
  return user.sub;
}
