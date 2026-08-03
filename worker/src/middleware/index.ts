// ============================================================
// جميع الميدلوير في ملف واحد
// ============================================================

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

// ... (جميع الدوال الأخرى كما هي) ...

// --- Helper functions for cookies ---
export function setSecureCookies(res: any, accessToken: string, csrfToken: string, partitioned: boolean = false) {
  const partitionedFlag = partitioned ? '; Partitioned' : '';
  res.headers.append(
    'Set-Cookie',
    `__Host-access_token=${accessToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900; Priority=High${partitionedFlag}`
  );
  res.headers.append(
    'Set-Cookie',
    `__Host-csrf=${csrfToken}; Secure; SameSite=Strict; Path=/; Max-Age=3600${partitionedFlag}`
  );
}

export function clearSecureCookies(res: any) {
  res.headers.append('Set-Cookie', '__Host-access_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.headers.append('Set-Cookie', '__Host-csrf=; Secure; SameSite=Strict; Path=/; Max-Age=0');
}
