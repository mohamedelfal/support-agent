/**
 * أدوات وكيل الدعم الفني
 */

import { action } from '@cloudflare/think';
import { z } from 'zod';
import type { Env } from './worker';

export function updateEmailAction(env: Env) {
  return action({
    description: 'تحديث البريد الإلكتروني للمستخدم بعد تأكيده',
    inputSchema: z.object({
      newEmail: z.string().email().describe('البريد الإلكتروني الجديد'),
    }),
    requiresApproval: true,
    execute: async ({ newEmail }, ctx) => {
      const db = env.DB;
      const userId = ctx.agent.userId;

      await db
        .prepare('UPDATE users SET email = ? WHERE id = ?')
        .bind(newEmail, userId)
        .run();

      return {
        success: true,
        message: `✅ تم تحديث بريدك الإلكتروني إلى ${newEmail} بنجاح.`,
        newEmail,
      };
    },
  });
}

export async function getOrderStatusTool(orderNumber: string): Promise<string> {
  return `📦 حالة الطلب رقم ${orderNumber}: قيد التوصيل. رقم التتبع: TRK-${orderNumber}`;
}

export function createTicketAction(env: Env) {
  return action({
    description: 'إنشاء تذكرة دعم جديدة لمشكلة يواجهها العميل',
    inputSchema: z.object({
      issue: z.string().describe('وصف المشكلة بالتفصيل'),
      orderNumber: z.string().optional().describe('رقم الطلب المرتبط إن وجد'),
    }),
    requiresApproval: true,
    execute: async ({ issue, orderNumber }, ctx) => {
      const db = env.DB;
      const userId = ctx.agent.userId;

      const openTicket = await db
        .prepare('SELECT id FROM tickets WHERE user_id = ? AND status = "open" LIMIT 1')
        .bind(userId)
        .first();

      if (openTicket) {
        return {
          success: false,
          message: `📋 لديك تذكرة مفتوحة بالفعل برقم ${(openTicket as any).id.slice(0, 8)}. سيتم التواصل معك قريباً.`,
        };
      }

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
        success: true,
        message: `✅ تم إنشاء تذكرة دعم برقم ${ticketId.slice(0, 8)}. سيقوم فريق الدعم بالرد خلال ٢٤ ساعة.`,
        ticketId: ticketId.slice(0, 8),
        issue: fullIssue,
      };
    },
  });
}
