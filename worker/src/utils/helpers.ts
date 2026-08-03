// ============================================================
// دوال مساعدة
// ============================================================

import { generateULID, hmacSign } from './crypto';

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function generateCorrelationId(): string {
  return generateULID();
}

export function getClientIP(c: any): string {
  return c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0] ||
    'unknown';
}

export async function hashIP(ip: string, secret: string): Promise<string> {
  return await hmacSign(ip, secret);
}

export function extractDeviceInfo(userAgent: string): { deviceName: string; deviceType: string } {
  const ua = userAgent.toLowerCase();
  let deviceName = 'Unknown Device';
  let deviceType = 'desktop';

  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    deviceType = 'mobile';
    if (ua.includes('iphone')) deviceName = 'iPhone';
    else if (ua.includes('ipad')) deviceName = 'iPad';
    else if (ua.includes('android')) deviceName = 'Android';
    else deviceName = 'Mobile Device';
  } else if (ua.includes('tablet') || ua.includes('ipad')) {
    deviceType = 'tablet';
    deviceName = 'Tablet';
  } else if (ua.includes('windows')) {
    deviceName = 'Windows PC';
  } else if (ua.includes('mac')) {
    deviceName = 'Mac';
  } else if (ua.includes('linux')) {
    deviceName = 'Linux';
  }

  if (ua.includes('chrome') && !ua.includes('edg')) deviceName += ' (Chrome)';
  else if (ua.includes('firefox')) deviceName += ' (Firefox)';
  else if (ua.includes('safari') && !ua.includes('chrome')) deviceName += ' (Safari)';
  else if (ua.includes('edg')) deviceName += ' (Edge)';

  return { deviceName, deviceType };
}

export function withSoftDelete(table: string, columns: string = '*'): string {
  return `SELECT ${columns} FROM ${table} WHERE deleted_at IS NULL`;
}
