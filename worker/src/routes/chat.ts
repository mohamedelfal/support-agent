import { Hono } from 'hono';
import { Env } from '../types';
import { SupportService } from '../services/support.service';
import { getUserId } from '../middleware';
import { ChatSchema } from '../types';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json();
  const result = ChatSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const service = new SupportService(c.env);
  const response = await service.sendMessage(
    userId,
    result.data.message,
    result.data.conversation_id
  );
  return c.json(response);
});

export default app;
