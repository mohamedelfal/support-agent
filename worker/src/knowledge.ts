/**
 * نظام RAG (Retrieval-Augmented Generation)
 * 
 * استراتيجية البحث:
 * 1. بحث نصي تقليدي (LIKE) في question و keywords
 * 2. بحث بالتضمين (Embeddings) مع توليد تلقائي للتضمينات المفقودة
 * 3. ردود احتياطية (Fallback) للأسئلة الشائعة
 */

import { Env } from './env';

export async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  try {
    const response = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
      text: text
    });
    return response.embedding || [];
  } catch (error) {
    console.error('❌ Embedding error:', error);
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * توليد Embedding لسؤال معين وحفظه في قاعدة البيانات
 */
async function ensureEmbedding(
  db: D1Database,
  recordId: string,
  question: string,
  env: Env
): Promise<number[]> {
  // جلب السجل الحالي
  const record = await db
    .prepare('SELECT embedding FROM knowledge WHERE id = ?')
    .bind(recordId)
    .first();
  
  if (!record) return [];
  
  const currentEmbedding = (record as any).embedding;
  
  // إذا كان التضمين موجوداً وغير فارغ، نعيده
  if (currentEmbedding && currentEmbedding !== '[]') {
    try {
      return JSON.parse(currentEmbedding);
    } catch {
      // إذا كان التضمين غير صالح، نستمر لتوليد جديد
    }
  }
  
  // توليد تضمين جديد
  const embedding = await generateEmbedding(question, env);
  
  // حفظ التضمين في قاعدة البيانات
  await db
    .prepare('UPDATE knowledge SET embedding = ? WHERE id = ?')
    .bind(JSON.stringify(embedding), recordId)
    .run();
  
  console.log(`✅ Generated embedding for record ${recordId}`);
  return embedding;
}

/**
 * معالجة الأسئلة المعرفية (RAG)
 * 
 * استراتيجية البحث المزدوجة:
 * 1. بحث نصي (LIKE) - أولاً
 * 2. بحث بالتضمين (Embeddings) - مع توليد تلقائي للمفقود
 * 3. ردود احتياطية (Fallback)
 */
export async function handleKnowledgeQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  intentType?: string
): Promise<Response | null> {
  try {
    // ============================================================
    // 1. البحث النصي التقليدي (LIKE) - الأولوية الأولى
    // ============================================================
    const words = question.split(' ').filter((w: string) => w.length > 2);
    let textMatch = null;
    let matchedId = null;
    
    for (const word of words) {
      const result = await db
        .prepare(
          `SELECT id, answer FROM knowledge 
           WHERE question LIKE ? OR keywords LIKE ? 
           LIMIT 1`
        )
        .bind(`%${word}%`, `%${word}%`)
        .all();
      
      if (result.results && result.results.length > 0) {
        textMatch = result.results[0].answer as string;
        matchedId = result.results[0].id as string;
        break;
      }
    }

    // إذا وجدنا تطابقاً نصياً
    if (textMatch) {
      // التأكد من وجود تضمين لهذا السجل (للاستخدام المستقبلي)
      if (matchedId) {
        // نقوم بتوليد التضمين في الخلفية (لا ننتظره)
        ensureEmbedding(db, matchedId, question, c.env).catch(console.error);
      }
      
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, textMatch, new Date().toISOString())
        .run();
      return c.json({ answer: textMatch });
    }

    // ============================================================
    // 2. البحث بالتضمين (Embeddings) - إذا لم نجد تطابقاً نصياً
    // ============================================================
    const allKnowledge = await db
      .prepare('SELECT id, question, answer, embedding FROM knowledge')
      .all();

    const questionEmbedding = await generateEmbedding(question, c.env);

    let bestMatch: any = null;
    let highestSimilarity = -1;
    const THRESHOLD = 0.4;

    if (questionEmbedding.length > 0 && allKnowledge.results) {
      for (const record of allKnowledge.results) {
        // التأكد من وجود تضمين، وإذا لم يكن موجوداً نقوم بتوليده
        let recordEmbedding: number[] = [];
        if (record.embedding && record.embedding !== '[]') {
          try {
            recordEmbedding = JSON.parse(record.embedding as string);
          } catch {
            recordEmbedding = [];
          }
        }
        
        // إذا لم يكن هناك تضمين، نولده
        if (recordEmbedding.length === 0) {
          recordEmbedding = await ensureEmbedding(db, record.id as string, record.question as string, c.env);
        }
        
        if (recordEmbedding.length > 0) {
          const similarity = cosineSimilarity(questionEmbedding, recordEmbedding);
          if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = record;
          }
        }
      }
    }

    if (bestMatch && highestSimilarity > THRESHOLD) {
      const answer = bestMatch.answer as string;
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString())
        .run();
      return c.json({ answer });
    }

    // ============================================================
    // 3. ردود احتياطية (Fallback) - للأسئلة الشائعة
    // ============================================================
    
    // سياسة الارتجاع
    if (intentType === 'return_policy' || 
        (question.includes('سياسة') && (question.includes('استرجاع') || question.includes('ارتجاع')))) {
      const fallbackAnswer = '📋 سياسة الارتجاع لدينا: يمكنك إرجاع المنتج خلال ١٤ يوم من تاريخ الاستلام، بشرط أن يكون بحالته الأصلية مع العبوة والملحقات. يرجى التواصل مع فريق الدعم لبدء إجراءات الارجاع.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    // وسائل الدفع
    if (question.includes('دفع') || question.includes('وسائل') || question.includes('كارت') || question.includes('فيزا')) {
      const fallbackAnswer = '💳 نقبل الدفع عن طريق: بطاقات الائتمان (Visa, Mastercard, American Express)، المحافظ الرقمية (Apple Pay, Google Pay)، والتحويل البنكي. الدفع نقداً غير متاح حالياً.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    // مدة الشحن
    if (question.includes('يستغرق') || question.includes('مدة') || question.includes('وقت') || 
        question.includes('شحن') || question.includes('وصول')) {
      const fallbackAnswer = '⏳ عادةً ما يستغرق وصول الطلب من ٣ إلى ٥ أيام عمل من تاريخ الشراء. يتم إرسال رقم تتبع على البريد الإلكتروني عند الشحن.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    // الأسئلة العامة (معرفة عامة)
    if (question.includes('بحيرة') || question.includes('نهر') || question.includes('جبل') || question.includes('محافظة')) {
      const fallbackAnswer = '🌍 هذا سؤال عام. ليس لدي معلومات دقيقة عن ذلك، لكن يمكنني مساعدتك في الأسئلة المتعلقة بالدعم الفني.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    // إذا لم نجد أي شيء
    return null;
  } catch (error) {
    console.error('❌ Knowledge error:', error);
    return null;
  }
}
