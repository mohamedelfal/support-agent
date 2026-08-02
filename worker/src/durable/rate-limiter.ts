
import { DurableObject } from 'cloudflare:workers';

interface RateLimitData {
  timestamps: number[];
  windowStart: number;
}

export class RateLimiter extends DurableObject {
  private data: RateLimitData;
  private initialized: Promise<void>;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.initialized = this.loadState();
  }

  private async loadState() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<RateLimitData>('data');
      this.data = stored || { timestamps: [], windowStart: Date.now() };
    });
  }

  private async saveState() {
    await this.ctx.storage.put('data', this.data);
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);

    if (url.pathname === '/rate-limit' && request.method === 'POST') {
      const { limit, window } = await request.json() as { limit: number; window: number };
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - window;

      this.data.timestamps = this.data.timestamps.filter(t => t > windowStart);
      this.data.timestamps.push(now);
      this.data.windowStart = Math.max(this.data.windowStart, windowStart);

      await this.saveState();

      const count = this.data.timestamps.length;
      const allowed = count <= limit;
      const remaining = Math.max(0, limit - count);
      const retryAfter = count >= limit ? window - (now - this.data.timestamps[0]) : 0;

      return Response.json({
        allowed,
        remaining,
        retryAfter: Math.max(0, retryAfter),
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
