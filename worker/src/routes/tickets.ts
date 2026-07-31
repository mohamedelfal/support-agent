// worker/src/routes/tickets.ts
import { Hono } from 'hono';
import { v4 } from 'uuid';
import { getUserId } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json();
  const { subject, description } = body;

  if (!subject || subject.length < 3) {
    return c.json({ error: 'Subject must be at least 3 characters' }, 400);
  }
  if (!description || description.length < 10) {
    return c.json({ error: 'Description must be at least 10 characters' }, 400);
  }

  const db = c.env.DB;
  const id = v4();
  await db.prepare(
    `INSERT INTO tickets (id, user_id, subject, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, subject, description, 'open', new Date().toISOString(), new Date().toISOString()).run();

  return c.json({ message: 'Ticket created', id });
});

app.get('/', async (c) => {
  const userId = getUserId(c);
  const db = c.env.DB;
  const { results } = await db.prepare(
    'SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return c.json({ tickets: results });
});

app.put('/:id/resolve', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const db = c.env.DB;

  const ticket = await db.prepare(
    'SELECT id FROM tickets WHERE id = ? AND user_id = ? AND status = ?'
  ).bind(id, userId, 'open').first();

  if (!ticket) {
    return c.json({ error: 'Ticket not found or already resolved' }, 404);
  }

  await db.prepare(
    'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind('resolved', new Date().toISOString(), id, userId).run();

  return c.json({ message: 'Ticket resolved' });
});

app.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const db = c.env.DB;
  await db.prepare('DELETE FROM tickets WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return c.json({ message: 'Ticket deleted' });
});

export default app;
