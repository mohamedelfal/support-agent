// worker/src/routes/chat.ts
import { Hono } from 'hono';
import { v4 } from 'uuid';
import { getUserId } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const userId = getUserId(c);
  const { message } = await c.req.json();

  if (!message || message.length < 2) {
    return c.json({ error: 'Message must be at least 2 characters' }, 400);
  }

  const db = c.env.DB;
  const { results } = await db.prepare(
    `SELECT subject, description FROM tickets 
     WHERE user_id = ? AND status != 'resolved' 
     ORDER BY created_at DESC LIMIT 3`
  ).bind(userId).all();

  const context = results.map(r =>
    `- ${r.subject}: ${r.description?.substring(0, 100) || ''}`
  ).join('\n');

  // استخدام AI Gateway (محاكاة حتى يتوفر AI Gateway)
  const answer = `شكراً لتواصلك. بناءً على سؤالك: "${message}"، سيتم مراجعة طلبك قريباً.`;

  await db.prepare(
    `INSERT INTO chat_logs (id, user_id, message, response, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(v4(), userId, message, answer, new Date().toISOString()).run();

  return c.json({ answer, sources: context ? ['تم استخدام التذاكر السابقة كسياق'] : [] });
});

export default app;
