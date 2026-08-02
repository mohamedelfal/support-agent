import { Env, User } from '../types';
import { generateULID } from '../utils/crypto';
import { logger, isValidEmail } from '../utils/helpers';
import { OTPService } from './otp.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';
import { RefreshService } from './refresh.service';
import { AuditProducer } from '../queue/audit-producer';

export class LoginService {
  private otpService: OTPService;
  private sessionService: SessionService;
  private tokenService: TokenService;
  private refreshService: RefreshService;
  private auditProducer: AuditProducer;

  constructor(private env: Env) {
    this.otpService = new OTPService(env);
    this.sessionService = new SessionService(env);
    this.tokenService = new TokenService(env);
    this.refreshService = new RefreshService(env);
    this.auditProducer = new AuditProducer(env);
  }

  async login(email: string, ip: string, userAgent: string, headers: Record<string, string>) {
    if (!isValidEmail(email)) {
      return { error: 'Invalid email' };
    }
    const cleanEmail = email.trim().toLowerCase();

    if (this.env.AUTH_MODE === 'development') {
      const user = await this.getOrCreateUser(cleanEmail);
      const session = await this.sessionService.create(user.id, ip, userAgent, headers);
      const familyId = await this.refreshService.createFamily(user.id, session.id);
      const tokens = await this.refreshService.createToken(familyId);
      const accessToken = await this.tokenService.createAccessToken(
        user.id,
        user.email,
        session.id,
        familyId
      );
      await this.auditProducer.log('login_dev_bypass', user.id, ip, userAgent);
      return {
        success: true,
        accessToken,
        refreshToken: tokens.token,
        tokenId: tokens.tokenId,
        familyId,
        user,
        requiresOTP: false,
      };
    }

    const otpResult = await this.otpService.generate(cleanEmail);
    if (!otpResult.success) {
      return { error: otpResult.error };
    }

    await this.auditProducer.log('otp_requested', null, ip, userAgent, { email: cleanEmail });

    return {
      success: true,
      requiresOTP: true,
      challengeId: otpResult.challengeId,
      message: 'OTP sent',
    };
  }

  async verifyOTP(email: string, code: string, challengeId: string, ip: string, userAgent: string, headers: Record<string, string>) {
    const cleanEmail = email.trim().toLowerCase();

    if (this.env.AUTH_MODE === 'staging' && this.env.STAGING_MASTER_OTP === code) {
      const user = await this.getOrCreateUser(cleanEmail);
      const session = await this.sessionService.create(user.id, ip, userAgent, headers);
      const familyId = await this.refreshService.createFamily(user.id, session.id);
      const tokens = await this.refreshService.createToken(familyId);
      const accessToken = await this.tokenService.createAccessToken(
        user.id,
        user.email,
        session.id,
        familyId
      );
      await this.auditProducer.log('otp_master_verified', user.id, ip, userAgent);
      return { success: true, accessToken, refreshToken: tokens.token, tokenId: tokens.tokenId, familyId, user };
    }

    const otpResult = await this.otpService.verify(cleanEmail, code, challengeId);
    if (!otpResult.success) {
      return { error: otpResult.error };
    }

    const user = await this.getOrCreateUser(cleanEmail);
    const session = await this.sessionService.create(user.id, ip, userAgent, headers);
    const familyId = await this.refreshService.createFamily(user.id, session.id);
    const tokens = await this.refreshService.createToken(familyId);
    const accessToken = await this.tokenService.createAccessToken(
      user.id,
      user.email,
      session.id,
      familyId
    );
    await this.auditProducer.log('otp_verified', user.id, ip, userAgent);

    return { success: true, accessToken, refreshToken: tokens.token, tokenId: tokens.tokenId, familyId, user };
  }

  private async getOrCreateUser(email: string): Promise<User> {
    const db = this.env.DB;
    const stmtSelect = db.prepare(
      'SELECT id, email, email_verified, version, created_at, updated_at FROM users WHERE email = ? AND deleted_at IS NULL'
    );
    let user = await stmtSelect.bind(email).first();

    if (!user && this.env.AUTO_CREATE_USERS === 'true') {
      const id = generateULID();
      const now = new Date().toISOString();
      const stmtInsert = db.prepare(
        'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)'
      );
      await stmtInsert.bind(id, email, now, now).run();
      user = await stmtSelect.bind(email).first();
    }

    return user;
  }
}
