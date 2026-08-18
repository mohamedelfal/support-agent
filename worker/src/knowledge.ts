/**
 * نظام RAG (Retrieval-Augmented Generation)
 * 
 * يحتوي على: توليد Embedding، حساب التشابه، معالجة الأسئلة المعرفية
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
 */
export async function handleKnowledgeQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  intentType?: string
): Promise<Response> {
  try {
    // 1. جلب جميع سجلات المعرفة
    const allKnowledge = await db
      .prepare('SELECT id, question, answer, embedding FROM knowledge')
      .all();

    // 2. توليد Embedding لسؤال العميل
    const questionEmbedding = await generateEmbedding(question, c.env);

    // 3. البحث عن أفضل تطابق
    let bestMatch: any = null;
    let highestSimilarity = -1;
    const THRESHOLD = 0.5;

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

    // 4. إذا وجدنا تطابقاً
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

    // 5. سياسة الارتجاع
    if (intentType === 'return_policy') {
      const fallbackAnswer = '📋 سياسة الارتجاع لدينا: يمكنك إرجاع المنتج خلال ١٤ يوم من تاريخ الاستلام، بشرط أن يكون بحالته الأصلية. يرجى التواصل مع فريق الدعم لبدء إجراءات الارجاع.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    // 6. سياسة الشحن
    if (intentType === 'shipping_policy') {
      const fallbackAnswer = '⏳ عادةً ما يستغرق وصول الطلب من ٣ إلى ٥ أيام عمل من تاريخ الشراء. يتم إرسال رقم تتبع على البريد الإلكتروني عند الشحن.';
      await db
        .prepare(
          'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, question, fallbackAnswer, new Date().toISOString())
        .run();
      return c.json({ answer: fallbackAnswer });
    }

    return null; // لم نجد إجابة، سنعود للـ General Question
  } catch (error) {
    console.error('❌ Knowledge error:', error);
    return null;
  }
}
