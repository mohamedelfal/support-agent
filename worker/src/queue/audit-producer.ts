import { Env } from '../types';
import { generateULID } from '../utils/crypto';
import { hashIP } from '../utils/helpers';

export class AuditProducer {
  constructor(private env: Env) {}

  async log(
    action: string,
    userId: string | null,
    ip: string,
    userAgent: string,
    metadata?: any
  ): Promise<void> {
    const entry = {
      id: generateULID(),
      userId,
      action,
      ipHash: await hashIP(ip, this.env.OTP_SECRET),
      userAgent,
      metadata: metadata ? JSON.stringify(metadata) : null,
      correlationId: generateULID(),
      createdAt: new Date().toISOString(),
    };

    try {
      const queue = this.env.AUDIT_QUEUE;
      await queue.send(entry);
    } catch (error) {
      console.error('Failed to send to queue, writing fallback:', error);
      await this.writeFallback(entry);
    }
  }

  private async writeFallback(entry: any): Promise<void> {
    const db = this.env.DB;
    const stmt = db.prepare(
      'INSERT INTO audit_logs (id, user_id, action, ip_hash, user_agent, metadata, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    await stmt.bind(
      entry.id,
      entry.userId,
      entry.action,
      entry.ipHash,
      entry.userAgent,
      entry.metadata,
      entry.correlationId,
      entry.createdAt
    ).run();
  }
}
