// ============================================================
// Token Service
// ============================================================

import { Env, TokenPayload } from '../types';
import { generateULID } from '../utils/crypto';
import { sign } from 'hono/jwt';

export class TokenService {
  constructor(private env: Env) {}

  async createAccessToken(
    userId: string,
    email: string,
    sessionId: string,
    familyId: string
  ): Promise<string> {
    const jti = generateULID();
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      sub: userId,
      email,
      jti,
      iss: 'support-agent',
      aud: 'support-agent-api',
      iat: now,
      nbf: now,
      exp: now + 60 * 15,
      session_id: sessionId,
      family_id: familyId,
    };

    return await sign(payload, this.env.JWT_SECRET_CURRENT);
  }

  async revokeAccessToken(jti: string, userId: string): Promise<void> {
    const db = this.env.DB;
    const stmt = db.prepare(
      'INSERT INTO token_blacklist (jti, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    );
    await stmt.bind(
      jti,
      userId,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString()
    ).run();
  }

  async isAccessTokenRevoked(jti: string): Promise<boolean> {
    const db = this.env.DB;
    const stmt = db.prepare('SELECT jti FROM token_blacklist WHERE jti = ? AND expires_at > ?');
    const result = await stmt.bind(jti, new Date().toISOString()).first();
    return !!result;
  }
}
