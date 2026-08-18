/**
 * دوال المصادقة: تسجيل الدخول، التحقق من المستخدم، تحديد معدل الطلبات
 */

import { Env } from './env';
import { sign, verify } from 'hono/jwt';

export async function checkRateLimit(
  env: Env,
  email: string
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const kv = env.RATE_LIMIT_KV;
  const key = `login:${email}`;
  const now = Math.floor(Date.now() / 1000);
  const windowSize = 15 * 60;
  const maxAttempts = 5;

  let data = await kv.get(key, 'json') as
    | { attempts: number; firstAttempt: number }
    | null;

  if (!data) {
    await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), {
      expirationTtl: windowSize,
    });
    return { allowed: true };
  }

  if (now - data.firstAttempt > windowSize) {
    await kv.put(key, JSON.stringify({ attempts: 1, firstAttempt: now }), {
      expirationTtl: windowSize,
    });
    return { allowed: true };
  }

  const newAttempts = data.attempts + 1;
  await kv.put(
    key,
    JSON.stringify({ attempts: newAttempts, firstAttempt: data.firstAttempt }),
    { expirationTtl: windowSize }
  );

  if (newAttempts > maxAttempts) {
    return {
      allowed: false,
      retryAfter: windowSize - (now - data.firstAttempt),
    };
  }

  return { allowed: true };
}

export async function loginUser(c: any, db: D1Database, email: string) {
  const cleanEmail = email.trim().toLowerCase();
  let user = await db
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(cleanEmail)
    .first();

  if (!user) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .bind(id, cleanEmail, now)
      .run();
    user = { id, email: cleanEmail, created_at: now };
  }

  const token = await sign(
    {
      sub: user.id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    },
    c.env.JWT_SECRET,
    'HS256'
  );

  return { token, user: { id: user.id, email: user.email } };
}

export async function verifyUser(c: any, db: D1Database) {
  const auth = c.req.header('Authorization');
  if (!auth) return null;

  const token = auth.replace('Bearer ', '');
  const payload = await verify(token, c.env.JWT_SECRET, 'HS256');

  if (!payload.sub) return null;

  const user = await db
    .prepare('SELECT id, email, created_at FROM users WHERE id = ?')
    .bind(payload.sub)
    .first();

  return user;
}
