
import { Hono } from 'hono';
import { Env } from '../types';
import { SupportService } from '../services/support.service';
import { getUserId } from '../middleware';
import { TicketSchema } from '../types';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json();
  const result = TicketSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const service = new SupportService(c.env);
  const response = await service.createTicket(userId, result.data.subject, result.data.description);
  return c.json(response);
});

app.get('/', async (c) => {
  const userId = getUserId(c);
  const service = new SupportService(c.env);
  const tickets = await service.getTickets(userId);
  return c.json({ tickets });
});

app.put('/:id/resolve', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const service = new SupportService(c.env);
  const response = await service.resolveTicket(userId, id);
  if (response.error) {
    return c.json({ error: response.error }, 404);
  }
  return c.json(response);
});

app.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const service = new SupportService(c.env);
  await service.deleteTicket(userId, id);
  return c.json({ success: true });
});

export default app;
