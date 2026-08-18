/**
 * نظام RAG (Retrieval-Augmented Generation)
 * 
 * استراتيجية البحث:
 * 1. بحث نصي تقليدي (LIKE) في question و keywords
 * 2. بحث بالتضمين (Embeddings) إذا لم نجد نتيجة
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
 * معالجة الأسئلة المعرفية (RAG)
 * 
 * استراتيجية بحث مزدوجة:
 * 1. بحث نصي تقليدي (LIKE) - سريع وموثوق
 * 2. بحث بالتضمين (Embeddings) - للمرونة
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
    
    for (const word of words) {
      const result = await db
        .prepare(
          `SELECT answer FROM knowledge 
           WHERE question LIKE ? OR keywords LIKE ? 
           LIMIT 1`
        )
        .bind(`%${word}%`, `%${word}%`)
        .all();
      
      if (result.results && result.results.length > 0) {
        textMatch = result.results[0].answer as string;
        break;
      }
    }

    // إذا وجدنا تطابقاً نصياً، نعيد الإجابة فوراً
    if (textMatch) {
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
    const THRESHOLD = 0.4; // عتبة أقل لتشمل المزيد من التطابقات

    if (questionEmbedding.length > 0 && allKnowledge.results) {
      for (const record of allKnowledge.results) {
        const recordEmbedding = record.embedding ? JSON.parse(record.embedding as string) : [];
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
    // 3. إذا لم نجد أي تطابق - ردود احتياطية (Fallback)
    // ============================================================
    
    // سياسة الارتجاع
    if (intentType === 'return_policy' || question.includes('سياسة') && (question.includes('استرجاع') || question.includes('ارتجاع'))) {
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
    if (question.includes('يستغرق') || question.includes('مدة') || question.includes('وقت') || question.includes('شحن') || question.includes('وصول')) {
      const fallbackAnswer = '⏳ عادةً ما يستغرق وصول الطلب من ٣ إلى ٥ أيام عمل من تاريخ الشراء. يتم إرسال رقم تتبع على البريد الإلكتروني عند الشحن.';
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
