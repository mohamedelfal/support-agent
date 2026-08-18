/**
 * معالجة الأسئلة العامة
 */

import { Env } from './env';
import { getGeneralSystemPrompt } from './prompts';
import { ConversationContext } from './sessions';

export async function handleGeneralQuestion(
  c: any,
  db: D1Database,
  userId: string,
  question: string,
  context: ConversationContext
): Promise<Response> {
  const history = await db
    .prepare(
      'SELECT message, response FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 3'
    )
    .bind(userId)
    .all();

  let historyContext = '';
  if (history.results && history.results.length > 0) {
    const reversed = history.results.reverse();
    historyContext = 'المحادثات السابقة (آخر 3 رسائل):\n';
    for (const rec of reversed) {
      historyContext += `- س: ${rec.message}\n- ج: ${rec.response}\n`;
    }
  }

  let contextInfo = '';
  if (context.pendingGoal) {
    contextInfo += `\nالهدف الحالي للعميل: ${context.pendingGoal}`;
  }
  if (context.orderNumber) {
    contextInfo += `\nرقم الطلب المذكور: ${context.orderNumber}`;
  }
  if (context.issueDescription) {
    contextInfo += `\nوصف المشكلة: ${context.issueDescription}`;
  }

  const systemPrompt = getGeneralSystemPrompt(historyContext, contextInfo);
  const fullPrompt = `${systemPrompt}\n\n${question}`;

  let aiResponse;
  try {
    aiResponse = await c.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0.7,
      max_tokens: 256,
      repetition_penalty: 1.1,
    });
  } catch (err) {
    console.error('AI Error:', err);
    return c.json({ answer: '⚠️ عذراً، حدث خطأ في الذكاء الاصطناعي. حاول مرة أخرى.' });
  }

  const answer = (aiResponse as any).response || '⚠️ عذراً، لم أستطع معالجة طلبك.';
  await db
    .prepare(
      'INSERT INTO conversations (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, question, answer, new Date().toISOString())
    .run();

  return c.json({ answer });
}
