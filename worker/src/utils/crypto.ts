const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;

function randomChar(): string {
  const random = crypto.getRandomValues(new Uint8Array(1))[0];
  return ENCODING[Math.floor((random / 255) * ENCODING_LEN)];
}

export function generateULID(): string {
  const timestamp = Date.now();
  let timeStr = '';
  let time = timestamp;
  for (let i = 0; i < 10; i++) {
    const remainder = time % ENCODING_LEN;
    timeStr = ENCODING[remainder] + timeStr;
    time = Math.floor(time / ENCODING_LEN);
  }
  let randomStr = '';
  for (let i = 0; i < 16; i++) {
    randomStr += randomChar();
  }
  return timeStr + randomStr;
}

export function isValidULID(id: string): boolean {
  return /^[0-9A-Z]{26}$/.test(id);
}

export function generateSecureToken(length: number = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalStringify(obj: any): string {
  if (typeof obj !== 'object' || obj === null) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const result: string[] = [];
  for (const key of keys) {
    const value = canonicalStringify(obj[key]);
    result.push(`${key}:${value}`);
  }
  return '{' + result.join(',') + '}';
}

let encryptionKey: CryptoKey | null = null;

export async function getEncryptionKey(secret: string): Promise<CryptoKey> {
  if (encryptionKey) return encryptionKey;
  const keyBytes = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  if (keyBytes.length !== 32) {
    throw new Error('Invalid AES key length. Expected 32 bytes.');
  }
  encryptionKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return encryptionKey;
}

export async function encryptText(text: string, secret: string): Promise<string> {
  const key = await getEncryptionKey(secret);
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return JSON.stringify({
    version: 'v1',
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
  });
}

export async function decryptText(encryptedText: string, secret: string): Promise<string> {
  const key = await getEncryptionKey(secret);
  const { version, iv: ivB64, data: dataB64 } = JSON.parse(encryptedText);
  if (version !== 'v1') {
    throw new Error('Unsupported encryption version');
  }
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return new TextDecoder().decode(decrypted);
}
