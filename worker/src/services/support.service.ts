import { Env } from '../types';
import { generateULID } from '../utils/crypto';
import { logger } from '../utils/logger';
import { AIService } from './ai.service';

export class SupportService {
  private aiService: AIService;

  constructor(private env: Env) {
    this.aiService = new AIService(env);
  }

  async createTicket(userId: string, subject: string, description: string) {
    const db = this.env.DB;
    const id = generateULID();
    const now = new Date().toISOString();

    const stmt = db.prepare(
      'INSERT INTO tickets (id, user_id, subject, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await stmt.bind(id, userId, subject, description, 'open', now, now).run();

    logger.info('Ticket created', { ticketId: id, userId });
    return { id };
  }

  async getTickets(userId: string) {
    const db = this.env.DB;
    const stmt = db.prepare(
      'SELECT id, subject, description, status, created_at FROM tickets WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    );
    const { results } = await stmt.bind(userId).all();
    return results;
  }

  async resolveTicket(userId: string, ticketId: string) {
    const db = this.env.DB;
    const stmt = db.prepare(
      'SELECT id FROM tickets WHERE id = ? AND user_id = ? AND status = ? AND deleted_at IS NULL'
    );
    const ticket = await stmt.bind(ticketId, userId, 'open').first();

    if (!ticket) {
      return { error: 'Ticket not found or already resolved' };
    }

    const stmtUpdate = db.prepare(
      'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?'
    );
    await stmtUpdate.bind('resolved', new Date().toISOString(), ticketId).run();

    logger.info('Ticket resolved', { ticketId, userId });
    return { success: true };
  }

  async deleteTicket(userId: string, ticketId: string) {
    const db = this.env.DB;
    const stmt = db.prepare(
      'UPDATE tickets SET deleted_at = ? WHERE id = ? AND user_id = ?'
    );
    await stmt.bind(new Date().toISOString(), ticketId, userId).run();

    logger.info('Ticket deleted', { ticketId, userId });
    return { success: true };
  }

  async sendMessage(userId: string, message: string, conversationId?: string) {
    const db = this.env.DB;
    const now = new Date().toISOString();
    const correlationId = generateULID();

    let convId = conversationId;
    if (!convId) {
      convId = generateULID();
      const stmtConv = db.prepare(
        'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      await stmtConv.bind(convId, userId, 'محادثة جديدة', now, now).run();
    }

    const stmtUserMsg = db.prepare(
      'INSERT INTO chat_messages (id, conversation_id, user_id, role, content, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await stmtUserMsg.bind(
      generateULID(),
      convId,
      userId,
      'user',
      message,
      correlationId,
      now
    ).run();

    const answer = await this.aiService.chat([
      { role: 'system', content: 'أنت مساعد دعم عملاء مفيد.' },
      { role: 'user', content: message },
    ]);

    const stmtAssistantMsg = db.prepare(
      'INSERT INTO chat_messages (id, conversation_id, user_id, role, content, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await stmtAssistantMsg.bind(
      generateULID(),
      convId,
      userId,
      'assistant',
      answer,
      correlationId,
      new Date().toISOString()
    ).run();

    logger.info('Chat message sent', { conversationId: convId, userId });
    return { conversationId: convId, answer };
  }
}
