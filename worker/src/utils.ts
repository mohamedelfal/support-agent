
/**
 * دوال مساعدة: استخراج الأرقام، البريد الإلكتروني، كشف النية
 */

import { ConversationContext } from './sessions';

export function extractNumber(text: string): string | null {
  const map: Record<string, string> = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
  };
  let normalized = text;
  for (const [ar, en] of Object.entries(map)) {
    normalized = normalized.replace(new RegExp(ar, 'g'), en);
  }
  const match = normalized.match(/\b(\d{4,})\b/);
  return match ? match[1] : null;
}

export function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

/**
 * كشف نية المستخدم بشكل متقدم
 */
export function detectIntent(
  question: string,
  context: ConversationContext
): {
  type:
    | 'update_email'
    | 'update_profile'
    | 'track_order'
    | 'shipping_policy'
    | 'return_policy'
    | 'create_ticket'
    | 'password_reset'
    | 'knowledge'
    | 'confirm'
    | 'cancel'
    | 'provide_email'
    | 'provide_code'
    | 'provide_order'
    | 'clarification_response'
    | 'password_choice'
    | 'general';
  data?: any;
} {
  const lower = question.toLowerCase();

  // 1. كشف الإلغاء
  if (lower.includes('إلغاء') || lower.includes('رجوع') || lower.includes('الغاء')) {
    return { type: 'cancel' };
  }

  // 2. كشف التأكيد
  if (lower.includes('نعم') || lower.includes('yes') || lower.includes('موافق')) {
    return { type: 'confirm' };
  }

  // 3. كشف اختيار رقم (لكلمة المرور)
  const numberMatch = question.match(/^(1|2|١|٢)$/);
  if (numberMatch) {
    return { type: 'password_choice', data: { choice: numberMatch[1] } };
  }

  // 4. كشف الأسئلة العامة
  const generalKeywords = ['ما هو', 'ما هي', 'ماذا', 'شرح', 'معنى', 'تعريف', 'ما دور', 'ما وظيفة', 'اقدم', 'اشهر'];
  if (generalKeywords.some(k => lower.includes(k))) {
    return { type: 'knowledge' };
  }

  // 5. كشف طلب إعادة تعيين كلمة المرور
  const passwordKeywords = ['نسيت', 'باسورد', 'كلمة السر', 'كلمة مرور', 'password', 'pass'];
  if (passwordKeywords.some(k => lower.includes(k))) {
    return { type: 'password_reset' };
  }

  // 6. كشف تحديث البريد الإلكتروني
  const updateKeywords = ['تحديث', 'تغيير', 'تعديل', 'تبديل', 'تجديد'];
  const emailKeywords = ['بريد', 'إيميل', 'ايميل', 'email', 'الإيميل', 'الايميل'];
  const hasUpdate = updateKeywords.some(k => lower.includes(k));
  const hasEmail = emailKeywords.some(k => lower.includes(k));

  if (hasUpdate && hasEmail) {
    return { type: 'update_email' };
  }

  // 7. كشف تحديث بيانات عامة
  if (hasUpdate && !hasEmail) {
    const profileKeywords = ['بيانات', 'حساب', 'معلومات', 'ملفي', 'بروفايل'];
    if (profileKeywords.some(k => lower.includes(k))) {
      return { type: 'update_profile' };
    }
  }

  // 8. كشف تتبع الطلب
  const orderKeywords = ['طلب', 'شحنة', 'تتبع', 'Track', 'Order', 'طلبى', 'طلبي', 'شحن'];
  const isOrderQuery = orderKeywords.some(k => lower.includes(k));
  const shippingTimeKeywords = ['مدة', 'وقت', 'كم', 'متي', 'متى', 'يستغرق', 'استلام', 'توصيل', 'شحن', 'وصول'];
  const isShippingTimeQuery = shippingTimeKeywords.some(k => lower.includes(k));

  if (context.pendingGoal === 'create_ticket') {
    if (lower.includes('تتبع') && isOrderQuery) {
      return { type: 'track_order' };
    }
    return { type: 'general' };
  }

  if (isOrderQuery && !isShippingTimeQuery) {
    return { type: 'track_order' };
  }

  // 9. كشف الاستفسار عن سياسة الشحن
  if (isShippingTimeQuery && (lower.includes('طلب') || lower.includes('شحن') || lower.includes('توصيل'))) {
    return { type: 'shipping_policy' };
  }

  // 10. كشف سياسة الارتجاع
  if (lower.includes('سياسة') && (lower.includes('ارتجاع') || lower.includes('مرتجع') || lower.includes('استرجاع'))) {
    return { type: 'return_policy' };
  }

  // 11. كشف إنشاء تذكرة
  const ticketKeywords = ['تذكرة', 'شكوى', 'مشكلة', 'دعم', 'مساعدة'];
  if (ticketKeywords.some(k => lower.includes(k))) {
    return { type: 'create_ticket' };
  }

  // 12. كشف البريد الإلكتروني
  const email = extractEmail(question);
  if (email) {
    return { type: 'provide_email', data: { email } };
  }

  // 13. كشف الكود
  const hasOnlyNumbers = /^\d+$/.test(question.trim());
  if (hasOnlyNumbers) {
    return { type: 'provide_code', data: { code: question.trim() } };
  }

  // 14. كشف رقم الطلب
  const order = extractNumber(question);
  if (order) {
    return { type: 'provide_order', data: { orderNumber: order } };
  }

  return { type: 'general' };
}
