import { Env } from '../types';
import { generateULID, hmacSign } from '../utils/crypto';
import { hashIP, extractDeviceInfo } from '../utils/helpers';
import { FingerprintService } from '../utils/fingerprint';

export class SessionService {
  private fingerprint: FingerprintService;

  constructor(private env: Env) {
    this.fingerprint = new FingerprintService(env.OTP_SECRET);
  }

  async create(
    userId: string,
    ip: string,
    userAgent: string,
    headers: Record<string, string>
  ): Promise<{ id: string; fingerprint: string }> {
    const db = this.env.DB;
    const id = generateULID();
    const now = new Date().toISOString();

    const fingerprint = await this.fingerprint.generate(ip, userAgent, headers);
    const ipHash = await hashIP(ip, this.env.OTP_SECRET);
    const deviceInfo = extractDeviceInfo(userAgent);

    const stmtInsert = db.prepare(
      'INSERT INTO sessions (id, user_id, fingerprint_hash, ip_hash, user_agent, device_name, device_type, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    await stmtInsert.bind(
      id,
      userId,
      fingerprint,
      ipHash,
      userAgent,
      deviceInfo.deviceName,
      deviceInfo.deviceType,
      now,
      now
    ).run();

    return { id, fingerprint };
  }

  async update(sessionId: string, ip: string, userAgent: string, headers: Record<string, string>): Promise<void> {
    const db = this.env.DB;
    const now = new Date().toISOString();
    const fingerprint = await this.fingerprint.generate(ip, userAgent, headers);
    const ipHash = await hashIP(ip, this.env.OTP_SECRET);

    const stmtUpdate = db.prepare(
      'UPDATE sessions SET fingerprint_hash = ?, ip_hash = ?, user_agent = ?, last_seen = ? WHERE id = ? AND revoked = ?'
    );
    await stmtUpdate.bind(fingerprint, ipHash, userAgent, now, sessionId, false).run();
  }

  async revoke(sessionId: string): Promise<void> {
    const db = this.env.DB;
    const stmtUpdate = db.prepare('UPDATE sessions SET revoked = ? WHERE id = ?');
    await stmtUpdate.bind(true, sessionId).run();
  }

  async verify(sessionId: string): Promise<{ valid: boolean; userId?: string }> {
    const db = this.env.DB;
    const stmtSelect = db.prepare(
      'SELECT user_id FROM sessions WHERE id = ? AND revoked = ?'
    );
    const result = await stmtSelect.bind(sessionId, false).first();

    if (!result) {
      return { valid: false };
    }

    return { valid: true, userId: result.user_id };
  }
}
