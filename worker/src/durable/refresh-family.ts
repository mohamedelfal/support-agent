
import { DurableObject } from 'cloudflare:workers';

interface RefreshTokenData {
  tokenHash: string;
  tokenId: string;
  createdAt: number;
  revoked: boolean;
}

interface FamilyState {
  tokens: RefreshTokenData[];
  lastConsumed: number;
  consumedCount: number;
}

export class RefreshFamily extends DurableObject {
  private state: FamilyState;
  private initialized: Promise<void>;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.initialized = this.loadState();
  }

  private async loadState() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<FamilyState>('state');
      this.state = stored || {
        tokens: [],
        lastConsumed: 0,
        consumedCount: 0,
      };
    });
  }

  private async saveState() {
    await this.ctx.storage.put('state', this.state);
  }

  async addToken(tokenHash: string, tokenId: string): Promise<void> {
    await this.initialized;
    this.state.tokens.push({
      tokenHash,
      tokenId,
      createdAt: Date.now(),
      revoked: false,
    });
    await this.saveState();
  }

  async consumeToken(tokenHash: string): Promise<{
    success: boolean;
    tokenId?: string;
    reuseDetected?: boolean;
  }> {
    await this.initialized;

    let foundIndex = -1;
    let foundToken: RefreshTokenData | null = null;

    for (let i = this.state.tokens.length - 1; i >= 0; i--) {
      if (this.state.tokens[i].tokenHash === tokenHash) {
        foundIndex = i;
        foundToken = this.state.tokens[i];
        break;
      }
    }

    if (!foundToken) {
      return { success: false };
    }

    if (foundToken.revoked) {
      for (const token of this.state.tokens) {
        token.revoked = true;
      }
      await this.saveState();
      return { success: false, reuseDetected: true };
    }

    foundToken.revoked = true;
    this.state.lastConsumed = Date.now();
    this.state.consumedCount++;

    await this.saveState();

    return {
      success: true,
      tokenId: foundToken.tokenId,
    };
  }

  async revokeAll(): Promise<void> {
    await this.initialized;
    for (const token of this.state.tokens) {
      token.revoked = true;
    }
    await this.saveState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/add' && request.method === 'POST') {
      const { tokenHash, tokenId } = await request.json();
      await this.addToken(tokenHash, tokenId);
      return Response.json({ success: true });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { tokenHash } = await request.json();
      const result = await this.consumeToken(tokenHash);
      return Response.json(result);
    }

    if (url.pathname === '/revoke-all' && request.method === 'POST') {
      await this.revokeAll();
      return Response.json({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
