import { Env } from '../types';

const MAX_RETRIES = 3;
const BATCH_SIZE = 100;

export async function auditConsumer(env: Env, messages: any[]): Promise<void> {
  const db = env.DB;
  const dlq = env.AUDIT_DLQ;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const entries: any[] = [];
    const failed: any[] = [];

    for (const message of batch) {
      try {
        const { id, userId, action, ipHash, userAgent, metadata, correlationId, createdAt } = message;

        const stmt = db.prepare(
          'INSERT OR IGNORE INTO audit_logs (id, user_id, action, ip_hash, user_agent, metadata, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        entries.push(stmt.bind(id, userId, action, ipHash, userAgent, metadata, correlationId, createdAt));
      } catch (error) {
        failed.push({ message, error });
      }
    }

    if (entries.length > 0) {
      try {
        await db.batch(entries);
      } catch (error) {
        for (const entry of entries) {
          try {
            await entry.run();
          } catch (e) {
            const msg = batch.find((m: any) => m.id === entry.bindings[0]);
            if (msg) {
              await handleFailedMessage(env, msg, e as Error);
            }
          }
        }
      }
    }

    for (const { message, error } of failed) {
      await handleFailedMessage(env, message, error);
    }
  }
}

async function handleFailedMessage(env: Env, message: any, error: Error): Promise<void> {
  const retryCount = message.retryCount || 0;
  if (retryCount < MAX_RETRIES) {
    message.retryCount = retryCount + 1;
    throw error;
  } else {
    const dlq = env.AUDIT_DLQ;
    await dlq.send({
      ...message,
      deadLetterReason: error.message,
      stackTrace: error.stack,
      deadLetterAt: new Date().toISOString(),
    });
  }
}
