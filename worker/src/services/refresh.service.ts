
import { Env } from '../types';
import { generateULID, generateSecureToken, hmacSign } from '../utils/crypto';
import { logger } from '../utils/logger';

export class RefreshService {
  constructor(private env: Env) {}

  private getFamilyObject(familyId: string) {
    const ns = this.env.REFRESH_FAMILY;
    return ns.get(ns.idFromName(familyId));
  }

  async createFamily(userId: string, sessionId: string): Promise<string> {
    const db = this.env.DB;
    const familyId = generateULID();
    const now = new Date().toISOString();

    const stmt = db.prepare(
      'INSERT INTO refresh_families (id, user_id, session_id, created_at) VALUES (?, ?, ?, ?)'
    );
    await stmt.bind(familyId, userId, sessionId, now).run();

    logger.info('Refresh family created', { familyId, userId, sessionId });
    return familyId;
  }

  async createToken(familyId: string): Promise<{ token: string; tokenId: string }> {
    const db = this.env.DB;
    const token = generateSecureToken(32);
    const tokenId = generateULID();
    const hash = await hmacSign(token, this.env.OTP_SECRET);
    const now = new Date().toISOString();

    const stmt = db.prepare(
      'INSERT INTO refresh_tokens (id, family_id, token_hash, token_id, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    await stmt.bind(generateULID(), familyId, hash, tokenId, now).run();

    const obj = this.getFamilyObject(familyId);
    await obj.fetch('https://internal/add', {
      method: 'POST',
      body: JSON.stringify({ tokenHash: hash, tokenId }),
    });

    return { token, tokenId };
  }

  async consumeToken(familyId: string, token: string): Promise<{
    success: boolean;
    tokenId?: string;
    userId?: string;
    sessionId?: string;
    reuseDetected?: boolean;
  }> {
    const db = this.env.DB;
    const hash = await hmacSign(token, this.env.OTP_SECRET);

    const stmtToken = db.prepare(
      'SELECT rt.id, rt.token_id, rt.family_id, rt.revoked, rf.user_id, rf.session_id FROM refresh_tokens rt JOIN refresh_families rf ON rt.family_id = rf.id WHERE rt.token_hash = ? AND rt.revoked = ?'
    );
    const tokenRecord = await stmtToken.bind(hash, false).first();

    if (!tokenRecord) {
      const stmtRevoked = db.prepare(
        'SELECT rt.revoked, rf.user_id, rf.session_id FROM refresh_tokens rt JOIN refresh_families rf ON rt.family_id = rf.id WHERE rt.token_hash = ?'
      );
      const revokedRecord = await stmtRevoked.bind(hash).first();

      if (revokedRecord && revokedRecord.revoked) {
        await this.revokeFamily(familyId);
        logger.warn('Refresh token reuse detected', { familyId });
        return { success: false, reuseDetected: true };
      }
      return { success: false };
    }

    const stmtRevoke = db.prepare(
      'UPDATE refresh_tokens SET revoked = ? WHERE id = ? AND revoked = ?'
    );
    const result = await stmtRevoke.bind(true, tokenRecord.id, false).run();

    if (result.meta?.rows_written === 0) {
      return { success: false, reuseDetected: true };
    }

    const obj = this.getFamilyObject(familyId);
    await obj.fetch('https://internal/consume', {
      method: 'POST',
      body: JSON.stringify({ tokenHash: hash }),
    });

    return {
      success: true,
      tokenId: tokenRecord.token_id,
      userId: tokenRecord.user_id,
      sessionId: tokenRecord.session_id,
    };
  }

  async revokeFamily(familyId: string): Promise<void> {
    const db = this.env.DB;

    const stmtFamily = db.prepare(
      'UPDATE refresh_families SET revoked = ?, revoked_at = ? WHERE id = ?'
    );
    await stmtFamily.bind(true, new Date().toISOString(), familyId).run();

    const stmtTokens = db.prepare(
      'UPDATE refresh_tokens SET revoked = ? WHERE family_id = ?'
    );
    await stmtTokens.bind(true, familyId).run();

    const obj = this.getFamilyObject(familyId);
    await obj.fetch('https://internal/revoke-all', { method: 'POST' });

    logger.info('Refresh family revoked', { familyId });
  }

  async verifyFamily(familyId: string): Promise<{ valid: boolean; userId?: string; sessionId?: string }> {
    const db = this.env.DB;
    const stmt = db.prepare(
      'SELECT user_id, session_id FROM refresh_families WHERE id = ? AND revoked = ?'
    );
    const result = await stmt.bind(familyId, false).first();

    if (!result) {
      return { valid: false };
    }

    return {
      valid: true,
      userId: result.user_id,
      sessionId: result.session_id,
    };
  }
}
