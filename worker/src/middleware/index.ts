import { Context } from 'hono';
import { verify } from 'hono/jwt';
import { Env, TokenPayload } from '../types';
import { logger } from '../utils/logger';
import {
  getClientIP,
  generateCorrelationId,
  hashIP,
} from '../utils/helpers';
import { generateTraceContext } from '../utils/logger';

export async function correlationIdMiddleware(c: Context, next: () => Promise<void>) {
  const correlationId = c.req.header('X-Correlation-ID') || generateCorrelationId();
  const traceContext = generateTraceContext();

  c.set('correlationId', correlationId);
  c.set('traceparent', traceContext.traceparent);

  c.res.headers.set('X-Correlation-ID', correlationId);
  c.res.headers.set('Traceparent', traceContext.traceparent);

  await next();
}

export async function securityHeaders(c: Context, next: () => Promise<void>) {
  await next();

  const nonce = generateCorrelationId().slice(0, 16);

  c.res.headers.set('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`
  );
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );
  c.res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  c.res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  c.set('cspNonce', nonce);
}

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  let token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    const match = c.req.header('Cookie')?.match(/__Host-access_token=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token) {
    return c.json({ error: 'Unauthorized: Missing token' }, 401);
  }

  let payload: TokenPayload | null = null;
  try {
    payload = await verify(token, c.env.JWT_SECRET_CURRENT);
  } catch {
    try {
      payload = await verify(token, c.env.JWT_SECRET_PREVIOUS);
    } catch {}
  }
  if (!payload) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'Unauthorized: Token expired' }, 401);
  }

  const db = c.env.DB;
  const stmt = db.prepare('SELECT jti FROM token_blacklist WHERE jti = ? AND expires_at > ?');
  const blacklist = await stmt.bind(payload.jti, new Date().toISOString()).first();
  if (blacklist) {
    return c.json({ error: 'Unauthorized: Token revoked' }, 401);
  }

  c.set('user', payload);
  await next();
}

export function getUserId(c: Context): string {
  const user = c.get('user');
  if (!user?.sub) {
    throw new Error('User not authenticated');
  }
  return user.sub;
}

export async function csrfMiddleware(c: Context, next: () => Promise<void>) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header('Origin');
  const allowedOrigins = ['https://support-agent.pages.dev', 'http://localhost:3000'];
  if (!origin || !allowedOrigins.includes(origin)) {
    return c.json({ error: 'Invalid origin' }, 403);
  }

  const csrfToken = c.req.header('X-CSRF-Token');
  const cookieToken = c.req.header('Cookie')?.match(/__Host-csrf=([^;]+)/)?.[1];
  if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
    return c.json({ error: 'Invalid CSRF token' }, 403);
  }
  await next();
}

export async function rateLimitMiddleware(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  const ip = getClientIP(c);
  const user = c.get('user');
  const userId = user?.sub || 'anonymous';
  const path = c.req.path;

  let limits: { key: string; limit: number; window: number }[] = [];

  if (path.includes('/auth/login')) {
    const email = (await c.req.json().catch(() => ({})))?.email || 'unknown';
    limits = [
      { key: `login:${email.toLowerCase()}`, limit: 5, window: 900 },
      { key: `ip:${ip}`, limit: 10, window: 900 },
    ];
  } else if (path.includes('/auth/verify-otp')) {
    const body = await c.req.json().catch(() => ({}));
    const challengeId = body.challengeId || 'unknown';
    limits = [
      { key: `otp:${challengeId}`, limit: 5, window: 300 },
      { key: `ip:${ip}`, limit: 10, window: 300 },
    ];
  } else if (path.includes('/chat')) {
    limits = [
      { key: `chat:${userId}`, limit: 30, window: 60 },
      { key: `ip:${ip}`, limit: 50, window: 60 },
    ];
  } else if (path.includes('/tickets')) {
    limits = [
      { key: `tickets:${userId}`, limit: 20, window: 60 },
      { key: `ip:${ip}`, limit: 40, window: 60 },
    ];
  } else {
    limits = [{ key: `ip:${ip}`, limit: 100, window: 60 }];
  }

  for (const { key, limit, window } of limits) {
    const limiter = c.env.RATE_LIMITER;
    const obj = limiter.get(limiter.idFromName(key));
    const res = await obj.fetch('https://internal/rate-limit', {
      method: 'POST',
      body: JSON.stringify({ limit, window }),
    });
    const data = await res.json();
    if (!data.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        retryAfter: data.retryAfter,
      }, 429);
    }
  }
  await next();
}

export async function idempotencyMiddleware(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  const key = c.req.header('Idempotency-Key');
  if (!key) {
    await next();
    return;
  }

  const cached = await c.env.CACHE_KV.get(`idempotency:${key}`);
  if (cached) {
    return c.json(JSON.parse(cached), 200);
  }

  await next();

  if (c.res.status === 200 || c.res.status === 201) {
    const body = await c.res.clone().json();
    await c.env.CACHE_KV.put(`idempotency:${key}`, JSON.stringify(body), { expirationTtl: 86400 });
  }
}

export async function requestValidationMiddleware(c: Context, next: () => Promise<void>) {
  const contentLength = parseInt(c.req.header('Content-Length') || '0');
  if (contentLength > 1024 * 1024) {
    return c.json({ error: 'Request body too large' }, 413);
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Request timeout')), 10000)
  );
  try {
    await Promise.race([next(), timeout]);
  } catch {
    return c.json({ error: 'Request timeout' }, 408);
  }
}

export function validateEnvironment(env: Env): { valid: boolean; error?: string } {
  const envs = ['development', 'staging', 'production'];
  if (!envs.includes(env.ENVIRONMENT)) {
    return { valid: false, error: `Invalid ENVIRONMENT: ${env.ENVIRONMENT}` };
  }
  if (!envs.includes(env.AUTH_MODE)) {
    return { valid: false, error: `Invalid AUTH_MODE: ${env.AUTH_MODE}` };
  }
  if (env.ENVIRONMENT === 'production' && env.AUTH_MODE !== 'production') {
    return { valid: false, error: 'Cannot run non-production AUTH_MODE in production' };
  }
  if (!env.JWT_SECRET_CURRENT || env.JWT_SECRET_CURRENT.length < 32) {
    return { valid: false, error: 'JWT_SECRET_CURRENT must be at least 32 characters' };
  }
  if (!env.OTP_SECRET || env.OTP_SECRET.length < 32) {
    return { valid: false, error: 'OTP_SECRET must be at least 32 characters' };
  }
  return { valid: true };
}
