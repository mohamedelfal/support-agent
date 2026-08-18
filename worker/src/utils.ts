/**
 * دوال مساعدة محسّنة
 * - استخراج الأرقام والبريد الإلكتروني
 * - كشف النية مع دعم الأخطاء الإملائية
 */

import { ConversationContext } from './sessions';

/**
 * حساب التشابه بين كلمتين باستخدام مسافة ليفنشتاين
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * التحقق من تشابه كلمتين (نسبة التشابه > 0.8)
 */
function isSimilar(word1: string, word2: string): boolean {
  if (word1 === word2) return true;
  const maxLen = Math.max(word1.length, word2.length);
  if (maxLen === 0) return true;
  const distance = levenshteinDistance(word1, word2);
  return (1 - distance / maxLen) >= 0.6;
}

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
  const generalKeywords = [
    'ما هو', 'ما هي', 'ماذا', 'شرح', 'معنى', 'تعريف', 'ما دور', 'ما وظيفة',
    'اقدم', 'اشهر', 'أقدم', 'أشهر', 'محافظة', 'بحيرة', 'نهر', 'جبل', 'صحراء'
  ];
  for (const kw of generalKeywords) {
    if (lower.includes(kw)) {
      return { type: 'knowledge' };
    }
  }

  // 5. كشف طلب إعادة تعيين كلمة المرور (مع دعم الأخطاء الإملائية)
  const passwordWords = ['نسيت', 'باسورد', 'كلمة السر', 'كلمة مرور', 'password', 'pass'];
  for (const word of question.split(' ')) {
    for (const pw of passwordWords) {
      if (isSimilar(word, pw) || lower.includes(pw)) {
        return { type: 'password_reset' };
      }
    }
  }

  // 6. كشف تحديث البريد الإلكتروني
  const updateWords = ['تحديث', 'تغيير', 'تعديل', 'تبديل', 'تجديد'];
  const emailWords = ['بريد', 'إيميل', 'ايميل', 'email', 'الإيميل', 'الايميل'];
  let hasUpdate = false;
  let hasEmail = false;
  for (const word of question.split(' ')) {
    for (const uw of updateWords) {
      if (isSimilar(word, uw) || lower.includes(uw)) hasUpdate = true;
    }
    for (const ew of emailWords) {
      if (isSimilar(word, ew) || lower.includes(ew)) hasEmail = true;
    }
  }
  if (hasUpdate && hasEmail) {
    return { type: 'update_email' };
  }

  // 7. كشف تحديث بيانات عامة
  if (hasUpdate && !hasEmail) {
    const profileWords = ['بيانات', 'حساب', 'معلومات', 'ملفي', 'بروفايل'];
    for (const word of question.split(' ')) {
      for (const pw of profileWords) {
        if (isSimilar(word, pw) || lower.includes(pw)) {
          return { type: 'update_profile' };
        }
      }
    }
  }

  // 8. كشف تتبع الطلب
  const orderWords = ['طلب', 'شحنة', 'تتبع', 'Track', 'Order', 'طلبى', 'طلبي', 'شحن'];
  const isOrderQuery = orderWords.some(k => lower.includes(k));
  const shippingTimeWords = ['مدة', 'وقت', 'كم', 'متي', 'متى', 'يستغرق', 'استلام', 'توصيل', 'شحن', 'وصول'];
  const isShippingTimeQuery = shippingTimeWords.some(k => lower.includes(k));

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
  const ticketWords = ['تذكرة', 'شكوى', 'مشكلة', 'دعم', 'مساعدة'];
  for (const word of question.split(' ')) {
    for (const tw of ticketWords) {
      if (isSimilar(word, tw) || lower.includes(tw)) {
        return { type: 'create_ticket' };
      }
    }
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
