/**
 * وكيل دعم فني - Kairos
 * يعتمد على إطار Think من Cloudflare
 * المطور: محمد عنتر الفل (Mohamed Antar Elfal)
 */

import { Think, action } from '@cloudflare/think';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import type { Env } from './worker';

// استيراد الأدوات من ملف منفصل
import { getOrderStatusTool, createTicketAction, updateEmailAction } from './tools';

export class KairosAgent extends Think<Env> {
  /**
   * تحديد النموذج المستخدم
   */
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      '@cf/meta/llama-3.2-3b-instruct'
    );
  }

  /**
   * التعليمات النظامية للوكيل
   */
  getSystemPrompt() {
    return `أنت وكيل دعم فني اسمك "Kairos".
تم تطويرك بواسطة المهندس محمد عنتر الفل (Mohamed Antar Elfal).
هدفك هو مساعدة العملاء في حل مشكلاتهم التقنية والإدارية.

قواعدك الأساسية:
1. استخدم اللغة العربية الفصحى فقط، ولا تخلط مع لغات أخرى.
2. إذا لم تكن متأكداً من الإجابة، قل بوضوح: "ليس لدي معلومات دقيقة حالياً".
3. تذكر سياق المحادثة ولا تكرر المعلومات.
4. قدم نفسك في أول رد فقط، ولا تكرر التعريف.
5. استخدم الأدوات المتاحة عند طلب العميل.
6. إذا طلب العميل إنشاء تذكرة، تأكد من فهم المشكلة جيداً قبل الإنشاء.

أنت وكيل ذكاء اصطناعي، لست المهندس محمد عنتر الفل، بل هو من قام بتطويرك.`;
  }

  /**
   * تهيئة جلسة المحادثة - الذاكرة الدائمة
   */
  configureSession(session: any) {
    // إضافة كتلة سياق للذاكرة الدائمة
    session.withContext('memory', {
      description: 'معلومات مهمة عن العميل يتم تذكرها طوال المحادثة',
      read: true,
      write: true,
    });

    // تفعيل البحث النصي الكامل (FTS5) في المحادثات السابقة
    session.withSearch();

    return session;
  }

  /**
   * أدوات الخادم (Actions) - مع ميزات متقدمة
   */
  getActions() {
    return {
      // أداة تحديث البريد الإلكتروني
      updateEmail: updateEmailAction(this.env),

      // أداة تتبع الطلب
      trackOrder: action({
        description: 'تتبع حالة طلب باستخدام رقم الطلب',
        inputSchema: z.object({
          orderNumber: z.string().describe('رقم الطلب المطلوب تتبعه'),
        }),
        execute: async ({ orderNumber }) => {
          return getOrderStatusTool(orderNumber);
        },
      }),

      // أداة إنشاء تذكرة دعم
      createTicket: createTicketAction(this.env),
    };
  }

  /**
   * عدد الخطوات القصوى للوكيل (منع الحلقات اللانهائية)
   */
  maxSteps = 5;

  /**
   * تفعيل استرداد المحادثة تلقائياً (Chat Recovery)
   */
  chatRecovery = true;
}
