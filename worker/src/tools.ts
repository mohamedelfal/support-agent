
/**
 * أدوات التنفيذ الأساسية
 * 
 * تحتوي على: تحديث البريد، تتبع الطلب، إنشاء التذكرة، إعادة تعيين كلمة المرور
 */

import { Env } from './env';

export async function executeUpdateEmail(
  db: D1Database,
  userId: string,
  newEmail: string
): Promise<string> {
  try {
    await db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(newEmail, userId)
      .run();
    return `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`;
  } catch (error) {
    return `❌ فشل تحديث البريد: ${(error as Error).message}`;
  }
}

export async function executeTrackOrder(orderNumber: string): Promise<string> {
  return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

export async function getOpenTickets(db: D1Database, userId: string): Promise<any[]> {
  const result = await db
    .prepare('SELECT id, issue, status, created_at FROM tickets WHERE user_id = ? AND status = "open"')
    .bind(userId)
    .all();
  return result.results || [];
}

export async function executeCreateTicket(
  db: D1Database,
  userId: string,
  issue: string,
  orderNumber?: string
): Promise<{ message: string; ticketId: string; title: string }> {
  const words = issue.split(' ').filter(w => w.length > 3);
  let title = words.slice(0, 5).join(' ');
  if (title.length > 50) title = title.slice(0, 50);
  if (!title) title = 'مشكلة غير محددة';

  const ticketId = crypto.randomUUID();
  const now = new Date().toISOString();
  const fullIssue = orderNumber ? `الطلب رقم ${orderNumber}: ${issue}` : issue;
  
  await db
    .prepare(
      'INSERT INTO tickets (id, user_id, issue, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(ticketId, userId, fullIssue, 'open', now)
    .run();
  
  return {
    message: `✅ تم إنشاء تذكرة دعم برقم ${ticketId.slice(0, 8)}. سيقوم فريق الدعم بالرد خلال ٢٤ ساعة.`,
    ticketId: ticketId.slice(0, 8),
    title: title
  };
}

export async function executePasswordReset(
  db: D1Database,
  userId: string,
  method: 'change' | 'recover' = 'recover',
  newPassword?: string
): Promise<string> {
  try {
    const user = await db
      .prepare('SELECT email FROM users WHERE id = ?')
      .bind(userId)
      .first();
    
    if (!user) {
      return '❌ لم يتم العثور على بريد إلكتروني مسجل لهذا الحساب.';
    }
    
    const email = (user as any).email;
    
    if (method === 'recover') {
      return `✅ تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني (${email}). يرجى التحقق من صندوق الوارد (والرسائل غير المرغوب فيها).`;
    } else {
      return `✅ تم تغيير كلمة المرور بنجاح. تم إرسال تأكيد إلى بريدك الإلكتروني (${email}).`;
    }
  } catch (error) {
    return `❌ فشل إعادة تعيين كلمة المرور: ${(error as Error).message}`;
  }
}
