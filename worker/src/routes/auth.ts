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
  try {
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
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ... (باقي نقاط النهاية مثل verify-otp, refresh, logout موجودة ولكن اختصرتها للعرض)

export default app;
