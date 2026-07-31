// worker/src/durable/rate-limiter.ts
import { DurableObject } from 'cloudflare:workers';

export class RateLimiter extends DurableObject {
  private state: any = {};

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.state = state.storage.get('state') || {};
  }

  async getState(): Promise<any> {
    return this.state;
  }

  async setState(data: any): Promise<void> {
    this.state = { ...this.state, ...data };
    await this.ctx.storage.put('state', this.state);
  }
}
