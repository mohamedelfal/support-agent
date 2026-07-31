// worker/src/routes/auth.ts
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { v4 } from 'uuid';
import { isValidEmail, sanitizeInput } from '../services/security';

const app = new Hono<{ Bindings: Env }>();

app.post('/login', async (c) => {
  const { email } = await c.req.json();
  const cleanEmail = sanitizeInput(email);

  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return c.json({ error: 'Invalid email format' }, 400);
  }

  const db = c.env.DB;
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();

  if (!user) {
    const id = v4();
    await db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).bind(id, cleanEmail, new Date().toISOString()).run();
    user = { id, email: cleanEmail };
  }

  const token = await sign(
    {
      sub: user.id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    },
    c.env.JWT_SECRET
  );

  return c.json({ token, user: { id: user.id, email: user.email } });
});

export default app;
