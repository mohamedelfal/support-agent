import { DurableObject } from 'cloudflare:workers';

interface Bucket {
  successes: number;
  failures: number;
  timestamp: number;
}

interface CBState {
  buckets: Bucket[];
  state: 'closed' | 'open' | 'half-open';
  lastFailure: number;
  lastSuccess: number;
  halfOpenSuccesses: number;
}

export class CircuitBreaker extends DurableObject {
  private state: CBState;
  private initialized: Promise<void>;
  private readonly WINDOW_SIZE = 60;
  private readonly BUCKET_SIZE = 1;
  private readonly MIN_REQUESTS = 20;
  private readonly FAILURE_THRESHOLD = 0.5;
  private readonly TIMEOUT = 60000;
  private readonly HALF_OPEN_SUCCESS_THRESHOLD = 3;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.initialized = this.loadState();
  }

  private async loadState() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<CBState>('state');
      this.state = stored || {
        buckets: [],
        state: 'closed',
        lastFailure: 0,
        lastSuccess: 0,
        halfOpenSuccesses: 0,
      };
    });
  }

  private async saveState() {
    await this.ctx.storage.put('state', this.state);
  }

  private getCurrentBucket(): Bucket | null {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - this.WINDOW_SIZE;
    this.state.buckets = this.state.buckets.filter(b => b.timestamp >= cutoff);

    let bucket = this.state.buckets.find(b => b.timestamp === now);
    if (!bucket) {
      bucket = { successes: 0, failures: 0, timestamp: now };
      this.state.buckets.push(bucket);
    }

    return bucket;
  }

  private getStats(): { total: number; failures: number; successRate: number } {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - this.WINDOW_SIZE;
    const activeBuckets = this.state.buckets.filter(b => b.timestamp >= cutoff);

    let total = 0;
    let failures = 0;

    for (const bucket of activeBuckets) {
      total += bucket.successes + bucket.failures;
      failures += bucket.failures;
    }

    return {
      total,
      failures,
      successRate: total > 0 ? (total - failures) / total : 1,
    };
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);

    if (url.pathname === '/state') {
      const now = Date.now();

      if (this.state.state === 'open' && (now - this.state.lastFailure) >= this.TIMEOUT) {
        this.state.state = 'half-open';
        this.state.halfOpenSuccesses = 0;
        await this.saveState();
        return Response.json({ state: 'half-open', open: false });
      }

      if (this.state.state === 'open') {
        return Response.json({ state: 'open', open: true });
      }

      return Response.json({ state: this.state.state, open: false });
    }

    if (url.pathname === '/success') {
      const bucket = this.getCurrentBucket();
      if (bucket) {
        bucket.successes++;
        this.state.lastSuccess = Date.now();
      }

      if (this.state.state === 'half-open') {
        this.state.halfOpenSuccesses++;
        if (this.state.halfOpenSuccesses >= this.HALF_OPEN_SUCCESS_THRESHOLD) {
          this.state.state = 'closed';
          this.state.buckets = [];
          this.state.halfOpenSuccesses = 0;
        }
      }

      await this.saveState();
      return Response.json({ success: true });
    }

    if (url.pathname === '/failure') {
      const bucket = this.getCurrentBucket();
      if (bucket) {
        bucket.failures++;
        this.state.lastFailure = Date.now();
      }

      const stats = this.getStats();

      if (this.state.state === 'half-open') {
        this.state.state = 'open';
        this.state.halfOpenSuccesses = 0;
      } else if (
        this.state.state === 'closed' &&
        stats.total >= this.MIN_REQUESTS &&
        stats.successRate < (1 - this.FAILURE_THRESHOLD)
      ) {
        this.state.state = 'open';
      }

      await this.saveState();
      return Response.json({ success: true, failures: stats.failures, state: this.state.state });
    }

    if (url.pathname === '/reset') {
      this.state = {
        buckets: [],
        state: 'closed',
        lastFailure: 0,
        lastSuccess: 0,
        halfOpenSuccesses: 0,
      };
      await this.saveState();
      return Response.json({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
