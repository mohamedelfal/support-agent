import { hmacSign } from './crypto';

export class FingerprintService {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  async generate(ip: string, userAgent: string, headers: Record<string, string>): Promise<string> {
    const coreFactors = [
      ip.substring(0, 15),
      userAgent.substring(0, 100),
      headers['accept-language'] || '',
    ];

    const optionalFactors = [
      headers['sec-ch-ua-platform'] || '',
      headers['sec-ch-ua-mobile'] || '',
      headers['sec-ch-ua'] || '',
      headers['device-memory'] || '',
      headers['viewport-width'] || '',
      headers['viewport-height'] || '',
    ];

    const factors = coreFactors.concat(optionalFactors.filter(f => f.length > 0));
    const fingerprintData = factors.join('|');

    return await hmacSign(fingerprintData, this.secret);
  }

  async compare(fingerprint1: string, fingerprint2: string, tolerance: number = 0.8): Promise<boolean> {
    if (fingerprint1 === fingerprint2) return true;

    const len = Math.min(fingerprint1.length, fingerprint2.length);
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (fingerprint1[i] === fingerprint2[i]) matches++;
    }
    const similarity = matches / Math.max(fingerprint1.length, fingerprint2.length);

    return similarity >= tolerance;
  }
}
