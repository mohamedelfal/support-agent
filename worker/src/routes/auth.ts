import { Hono } from 'hono';
import { Env } from '../types';
import { LoginService } from '../services/login.service';
import { RefreshService } from '../services/refresh.service';
import { TokenService } from '../services/token.service';
import { SessionService } from '../services/session.service';
import { AuditProducer } from '../queue/audit-producer';
import { getClientIP } from '../utils/helpers';
import { LoginSchema, VerifyOTPSchema, RefreshSchema } from '../types';
import { generateSecureToken } from '../utils/crypto';
import { setSecureCookies, clearSecureCookies } from '../middleware';

const app = new Hono<{ Bindings: Env }>();

app.post('/login', async (c) => {
  const body = await c.req.json();
  const result = LoginSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const loginService = new LoginService(c.env);
  const ip = getClientIP(c);
  const userAgent = c.req.header('User-Agent') || '';
  const headers = Object.fromEntries(c.req.headers.entries());

  const response = await loginService.login(result.data.email, ip, userAgent, headers);
  if (response.error) {
    return c.json({ error: response.error }, 400);
  }

  if (response.requiresOTP) {
    return c.json({ success: true, requiresOTP: true, challengeId: response.challengeId });
  }

  const res = c.json({
    success: true,
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    tokenId: response.tokenId,
    familyId: response.familyId,
    user: response.user,
  });

  const csrfToken = generateSecureToken(16);
  setSecureCookies(res, response.accessToken, csrfToken, true);
  res.headers.set('X-CSRF-Token', csrfToken);

  return res;
});

app.post('/verify-otp', async (c) => {
  const body = await c.req.json();
  const result = VerifyOTPSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const loginService = new LoginService(c.env);
  const ip = getClientIP(c);
  const userAgent = c.req.header('User-Agent') || '';
  const headers = Object.fromEntries(c.req.headers.entries());

  const response = await loginService.verifyOTP(
    result.data.email,
    result.data.code,
    result.data.challengeId || '',
    ip,
    userAgent,
    headers
  );
  if (response.error) {
    return c.json({ error: response.error }, 400);
  }

  const res = c.json({
    success: true,
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    tokenId: response.tokenId,
    familyId: response.familyId,
    user: response.user,
  });

  const csrfToken = generateSecureToken(16);
  setSecureCookies(res, response.accessToken, csrfToken, true);
  res.headers.set('X-CSRF-Token', csrfToken);

  return res;
});

app.post('/refresh', async (c) => {
  const body = await c.req.json();
  const result = RefreshSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const refreshService = new RefreshService(c.env);
  const tokenService = new TokenService(c.env);
  const sessionService = new SessionService(c.env);
  const auditProducer = new AuditProducer(c.env);

  const ip = getClientIP(c);
  const userAgent = c.req.header('User-Agent') || '';
  const headers = Object.fromEntries(c.req.headers.entries());

  const consumeResult = await refreshService.consumeToken(result.data.familyId, result.data.refreshToken);
  if (!consumeResult.success) {
    if (consumeResult.reuseDetected) {
      await refreshService.revokeFamily(result.data.familyId);
      await auditProducer.log('refresh_reuse_detected', null, ip, userAgent, { familyId: result.data.familyId });
      return c.json({ error: 'Refresh token reuse detected' }, 401);
    }
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const { userId, sessionId } = consumeResult;
  await sessionService.update(sessionId!, ip, userAgent, headers);

  const newTokens = await refreshService.createToken(result.data.familyId);
  const accessToken = await tokenService.createAccessToken(
    userId!,
    '',
    sessionId!,
    result.data.familyId
  );

  await auditProducer.log('refresh_success', userId!, ip, userAgent);

  const res = c.json({
    success: true,
    accessToken,
    refreshToken: newTokens.token,
    tokenId: newTokens.tokenId,
    familyId: result.data.familyId,
  });

  const csrfToken = generateSecureToken(16);
  setSecureCookies(res, accessToken, csrfToken, true);
  res.headers.set('X-CSRF-Token', csrfToken);

  return res;
});

app.post('/logout', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const tokenService = new TokenService(c.env);
  const sessionService = new SessionService(c.env);
  const refreshService = new RefreshService(c.env);
  const auditProducer = new AuditProducer(c.env);

  await tokenService.revokeAccessToken(user.jti, user.sub);
  await sessionService.revoke(user.session_id);
  await refreshService.revokeFamily(user.family_id);

  await auditProducer.log('logout', user.sub, '', '');

  const res = c.json({ success: true });
  clearSecureCookies(res);
  return res;
});

export default app;
