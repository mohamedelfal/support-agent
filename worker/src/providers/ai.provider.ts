
import { Env } from '../types';

export interface AIProvider {
  getName(): string;
  chat(messages: any[]): Promise<string>;
}

abstract class BaseAIProvider implements AIProvider {
  protected env: Env;
  protected timeout: number;

  constructor(env: Env, timeout: number = 30000) {
    this.env = env;
    this.timeout = timeout;
  }

  abstract getName(): string;
  abstract chat(messages: any[]): Promise<string>;

  protected async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await promise;
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }
}

export class GroqProvider extends BaseAIProvider {
  getName(): string { return 'groq'; }

  async chat(messages: any[]): Promise<string> {
    const resp = await this.withTimeout(
      this.env.AI_GATEWAY.chat({
        gatewayId: this.env.AI_GATEWAY_ID,
        provider: 'groq',
        model: 'llama3-8b-8192',
        messages,
        temperature: 0.3,
        max_tokens: 500,
      }),
      this.timeout
    );
    return resp.choices[0]?.message?.content || '';
  }
}

export class WorkersAIProvider extends BaseAIProvider {
  getName(): string { return 'workers-ai'; }

  async chat(messages: any[]): Promise<string> {
    const resp = await this.withTimeout(
      this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages,
        temperature: 0.3,
        max_tokens: 500,
      }),
      this.timeout
    );
    return resp.response || '';
  }
}

export class OpenAIProvider extends BaseAIProvider {
  getName(): string { return 'openai'; }

  async chat(messages: any[]): Promise<string> {
    const resp = await this.withTimeout(
      this.env.AI_GATEWAY.chat({
        gatewayId: this.env.AI_GATEWAY_ID,
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.3,
        max_tokens: 500,
      }),
      this.timeout
    );
    return resp.choices[0]?.message?.content || '';
  }
}
