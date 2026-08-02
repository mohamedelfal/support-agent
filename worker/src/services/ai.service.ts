import { Env } from '../types';
import { logger, canonicalStringify } from '../utils/helpers';
import { CacheService } from './cache.service';
import { AIProvider, GroqProvider, WorkersAIProvider, OpenAIProvider } from '../providers/ai.provider';

export class AIService {
  private cache: CacheService;
  private providers: AIProvider[];
  private readonly MAX_RETRIES = 3;

  constructor(private env: Env) {
    this.cache = new CacheService(env);
    this.providers = [
      new WorkersAIProvider(env, 15000),
      new GroqProvider(env, 20000),
      new OpenAIProvider(env, 30000),
    ];
  }

  async chat(messages: any[]): Promise<string> {
    const cacheKey = await this.getCacheKey(messages);
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const name = provider.getName();

      const cb = this.env.CIRCUIT_BREAKER;
      const obj = cb.get(cb.idFromName(`ai:${name}`));
      const stateRes = await obj.fetch('https://internal/state');
      const { open } = await stateRes.json();

      if (open) {
        logger.warn(`Circuit breaker open for ${name}`);
        continue;
      }

      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          const start = Date.now();
          const response = await provider.chat(messages);
          const latency = Date.now() - start;

          await obj.fetch('https://internal/success', { method: 'POST' });
          await this.cache.set(cacheKey, response, 3600);

          logger.info(`AI response from ${name}`, { latency, attempt });
          return response;
        } catch (error) {
          const err = error as Error;
          logger.warn(`Provider ${name} attempt ${attempt} failed`, { error: err.message });

          await obj.fetch('https://internal/failure', { method: 'POST' });

          if (attempt < this.MAX_RETRIES) {
            const delay = getFullJitterDelay(attempt, 1000, 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            lastError = err;
          }
        }
      }
    }

    throw lastError || new Error('All AI providers failed');
  }

  private async getCacheKey(messages: any[]): Promise<string> {
    const canonical = canonicalStringify(messages);
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return 'ai:' + Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

function getFullJitterDelay(attempt: number, baseDelay: number = 1000, maxDelay: number = 10000): number {
  const cap = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
  return Math.random() * cap;
}

export class CacheService {
  constructor(private env: Env) {}

  async get(key: string): Promise<string | null> {
    return await this.env.CACHE_KV.get(key);
  }

  async set(key: string, value: string, ttl: number = 3600): Promise<void> {
    await this.env.CACHE_KV.put(key, value, { expirationTtl: ttl });
  }

  async delete(key: string): Promise<void> {
    await this.env.CACHE_KV.delete(key);
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const data = await this.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async setJSON<T>(key: string, value: T, ttl?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttl);
  }
}
