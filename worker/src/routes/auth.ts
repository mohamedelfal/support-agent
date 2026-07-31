// worker/src/routes/auth.ts
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { v4 } from 'uuid';

const app = new Hono<{ Bindings: Env }>();

app.post('/login', async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const db = c.env.DB;
    let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

    if (!user) {
      const id = v4();
      await db.prepare(
        'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
      ).bind(id, email, new Date().toISOString()).run();
      user = { id, email };
    }

    const token = await sign(
      { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
      c.env.JWT_SECRET
    );

    return c.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
