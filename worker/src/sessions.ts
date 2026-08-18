
/**
 * نظام إدارة الجلسات
 * 
 * يحتوي على: إنشاء، تحديث، حذف، جلب الجلسات
 */

export type ConversationContext = {
  pendingGoal?: 'update_email' | 'track_order' | 'create_ticket' | 'password_reset' | null;
  orderNumber?: string;
  issueDescription?: string;
  lastAction?: string;
  userIntent?: string;
  ticketCount?: number;
  existingTickets?: any[];
};

export type SessionData = {
  step:
    | 'idle'
    | 'awaiting_email'
    | 'awaiting_code'
    | 'awaiting_order'
    | 'awaiting_order_confirm'
    | 'awaiting_ticket_issue'
    | 'awaiting_ticket_confirm'
    | 'awaiting_ticket_title'
    | 'awaiting_clarification'
    | 'awaiting_password_choice'
    | 'awaiting_password_confirm';
  context: ConversationContext;
  data: {
    newEmail?: string;
    verificationCode?: string;
    orderNumber?: string;
    ticketIssue?: string;
    ticketTitle?: string;
    clarificationQuestion?: string;
    passwordChoice?: string;
    existingTickets?: any[];
  };
};

export async function createSession(
  db: D1Database,
  userId: string,
  initialData: SessionData
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, action, step, data, created_at, expires_at, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      'state_machine',
      initialData.step,
      JSON.stringify(initialData.data || {}),
      now,
      expiresAt,
      JSON.stringify(initialData.context || {})
    )
    .run();
  return id;
}

export async function updateSession(
  db: D1Database,
  sessionId: string,
  data: SessionData
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE sessions
       SET step = ?, data = ?, created_at = ?, context = ?
       WHERE id = ?`
    )
    .bind(
      data.step,
      JSON.stringify(data.data || {}),
      now,
      JSON.stringify(data.context || {}),
      sessionId
    )
    .run();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function getActiveSession(
  db: D1Database,
  userId: string
): Promise<{ id: string; data: SessionData } | null> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `SELECT id, step, data, context
       FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, now)
    .first();
  if (!result) return null;
  return {
    id: result.id as string,
    data: {
      step: result.step as SessionData['step'],
      data: JSON.parse((result.data as string) || '{}'),
      context: JSON.parse((result.context as string) || '{}'),
    },
  };
}

export async function cleanExpiredSessions(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}
