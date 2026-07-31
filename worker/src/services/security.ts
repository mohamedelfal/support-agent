// worker/src/services/security.ts
export function sanitizeInput(input: string): string {
  if (!input) return '';
  return input.replace(/<[^>]*>/g, '').replace(/['";\\]/g, '').trim().slice(0, 1000);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}
