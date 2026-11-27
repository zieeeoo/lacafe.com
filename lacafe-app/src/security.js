import crypto from 'node:crypto';

// ---------- Password (scrypt, salt per user, perbandingan timing-safe) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Hash palsu agar waktu respon sama walau akun tidak ada (mencegah enumerasi akun).
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex') + 'a1');

export function verifyPassword(password, stored) {
  const target = stored || DUMMY_HASH;
  const [alg, N, r, p, saltB64, hashB64] = String(target).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  const ok = crypto.timingSafeEqual(expected, actual);
  return ok && !!stored;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Kode aktivasi mudah dibaca (tanpa 0/O/1/I), 8 karakter.
export function activationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

export function voucherCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let s = 'V';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

// ---------- Kode member berputar (seperti TOTP), berlaku 60 detik ----------
// Kasir mengetik 6 digit ini untuk menemukan member — tidak bisa ditebak dari ID member saja.
export const PASS_WINDOW = 60;
export function memberPassCode(secret, memberCode, at = Date.now()) {
  const win = Math.floor(at / 1000 / PASS_WINDOW);
  const mac = crypto.createHmac('sha256', secret).update(`${memberCode}:${win}`).digest();
  const n = mac.readUInt32BE(mac[mac.length - 1] & 0x0f) & 0x7fffffff;
  return String(n % 1000000).padStart(6, '0');
}
export function passExpiresIn(at = Date.now()) {
  return PASS_WINDOW - (Math.floor(at / 1000) % PASS_WINDOW);
}

// ---------- Rate limiter sederhana (in-memory, per kunci) ----------
export class RateLimiter {
  constructor({ windowMs, max }) { this.windowMs = windowMs; this.max = max; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) this.sweep(now);
    return arr.length <= this.max;
  }
  retryAfter(key) {
    const arr = this.hits.get(key) || [];
    return arr.length ? Math.ceil((this.windowMs - (Date.now() - arr[0])) / 1000) : 0;
  }
  sweep(now) {
    for (const [k, arr] of this.hits) if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

// ---------- Header keamanan ----------
export function securityHeaders(isHttps) {
  const h = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isHttps) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}
