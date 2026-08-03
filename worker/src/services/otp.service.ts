import { Env } from '../types';
import { generateULID, hmacSign } from '../utils/crypto';
import { logger } from '../utils/logger';

export class OTPService {
  constructor(private env: Env) {}

  async generate(email: string): Promise<{ success: boolean; challengeId?: string; error?: string }> {
    const db = this.env.DB;
    const challengeId = generateULID();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const hash = await hmacSign(`${otp}|${email}|${challengeId}|${expiresAt}`, this.env.OTP_SECRET);

    const stmtDelete = db.prepare('DELETE FROM otp_codes WHERE email = ? AND used = ?');
    await stmtDelete.bind(email, false).run();

    const stmtInsert = db.prepare(
      'INSERT INTO otp_codes (id, email, otp_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    await stmtInsert.bind(challengeId, email, hash, expiresAt, new Date().toISOString()).run();

    logger.info('OTP generated', { email, challengeId });

    return { success: true, challengeId };
  }

  async verify(email: string, code: string, challengeId: string): Promise<{ success: boolean; error?: string }> {
    const db = this.env.DB;

    const stmtSelect = db.prepare(
      'SELECT id, otp_hash, expires_at, attempts FROM otp_codes WHERE id = ? AND email = ? AND used = ? AND expires_at > ?'
    );
    const otp = await stmtSelect.bind(challengeId, email, false, new Date().toISOString()).first();

    if (!otp) {
      return { success: false, error: 'Invalid or expired OTP' };
    }

    if (otp.attempts >= 5) {
      const stmtUpdate = db.prepare('UPDATE otp_codes SET used = ? WHERE id = ?');
      await stmtUpdate.bind(true, challengeId).run();
      return { success: false, error: 'Too many attempts' };
    }

    const hash = await hmacSign(`${code}|${email}|${challengeId}|${otp.expires_at}`, this.env.OTP_SECRET);
    if (hash !== otp.otp_hash) {
      const stmtAttempts = db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?');
      await stmtAttempts.bind(challengeId).run();
      return { success: false, error: 'Invalid OTP' };
    }

    const stmtUsed = db.prepare('UPDATE otp_codes SET used = ? WHERE id = ?');
    await stmtUsed.bind(true, challengeId).run();

    return { success: true };
  }
}
