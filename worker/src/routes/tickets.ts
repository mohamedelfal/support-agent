// worker/src/routes/tickets.ts
import { Hono } from 'hono';
import { v4 } from 'uuid';
import { getUserId } from '../middleware/auth';
import { sanitizeInput, isValidUUID } from '../services/security';

const app = new Hono<{ Bindings: Env }>();

// إنشاء تذكرة
app.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json();

  const subject = sanitizeInput(body.subject);
  const description = sanitizeInput(body.description);

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

  // سجل التدقيق
  await db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, object_id, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(v4(), userId, 'ticket_create', id, await hashIP(c), new Date().toISOString()).run();

  return c.json({ message: 'Ticket created', id });
});

// جلب التذاكر
app.get('/', async (c) => {
  const userId = getUserId(c);
  const db = c.env.DB;
  const { results } = await db.prepare(
    'SELECT id, subject, description, status, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return c.json({ tickets: results });
});

// حل تذكرة
app.put('/:id/resolve', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    return c.json({ error: 'Invalid ticket ID' }, 400);
  }

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

  await db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, object_id, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(v4(), userId, 'ticket_resolve', id, await hashIP(c), new Date().toISOString()).run();

  return c.json({ message: 'Ticket resolved' });
});

// حذف تذكرة
app.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');

  if (!isValidUUID(id)) {
    return c.json({ error: 'Invalid ticket ID' }, 400);
  }

  const db = c.env.DB;
  await db.prepare(
    'DELETE FROM tickets WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();

  return c.json({ message: 'Ticket deleted' });
});

// دالة تجزئة IP
async function hashIP(c: any): Promise<string> {
  const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0';
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + c.env.JWT_SECRET);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default app;
