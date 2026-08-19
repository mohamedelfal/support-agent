/**
 * وكيل دعم فني - Kairos
 * يعتمد على إطار Think من Cloudflare
 */

import { Think, action } from '@cloudflare/think';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import type { Env } from './worker';
import { getOrderStatusTool, createTicketAction, updateEmailAction } from './tools';

export class KairosAgent extends Think<Env> {
  getModel() {
    try {
      return createWorkersAI({ binding: this.env.AI })(
        '@cf/meta/llama-3.2-3b-instruct'
      );
    } catch (error) {
      console.error('❌ getModel error:', error);
      // نموذج احتياطي
      return createWorkersAI({ binding: this.env.AI })(
        '@cf/mistral/mistral-small-3.1-24b-instruct'
      );
    }
  }

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

  configureSession(session: any) {
    session.withContext('memory', {
      description: 'معلومات مهمة عن العميل يتم تذكرها طوال المحادثة',
      read: true,
      write: true,
    });
    session.withSearch();
    return session;
  }

  getActions() {
    return {
      updateEmail: updateEmailAction(this.env),
      trackOrder: action({
        description: 'تتبع حالة طلب باستخدام رقم الطلب',
        inputSchema: z.object({
          orderNumber: z.string().describe('رقم الطلب المطلوب تتبعه'),
        }),
        execute: async ({ orderNumber }) => {
          return getOrderStatusTool(orderNumber);
        },
      }),
      createTicket: createTicketAction(this.env),
    };
  }

  // تفعيل استرداد المحادثة تلقائياً (Chat Recovery)
  chatRecovery = true;

  // عدد الخطوات القصوى للوكيل (منع الحلقات اللانهائية)
  maxSteps = 5;

  // معالجة أخطاء السياق الزائد
  contextOverflow = {
    reactive: true,
    classifyChatError: (error: any) => {
      if (error.message?.includes('context') || error.message?.includes('token')) {
        return 'context_overflow';
      }
      return null;
    },
  };
}
