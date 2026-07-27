import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP (SHA-1, 6 digits, 30s step) implemented on node:crypto so we
// don't pull in an OTP dependency. Secrets are base32 (RFC 4648) so any
// standard authenticator app (Google Authenticator, Authy, 1Password…) accepts
// them via QR or manual entry.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

/** A fresh 160-bit secret, base32-encoded (no padding). */
export function generateTotpSecret(): string {
  const buf = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * Verify a 6-digit code against the secret, allowing ±`window` steps to absorb
 * clock skew. Comparison is constant-time.
 */
export function verifyTotp(secretBase32: string, code: string, window = 1): boolean {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const want = Buffer.from(cleaned);
  for (let w = -window; w <= window; w++) {
    const got = Buffer.from(hotp(secret, counter + w));
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

/** The code valid right now for a secret (used by tests and diagnostics). */
export function currentTotpCode(secretBase32: string): string {
  return hotp(base32Decode(secretBase32), Math.floor(Date.now() / 1000 / STEP_SECONDS));
}

/** otpauth:// URI an authenticator app renders as a QR or accepts by paste. */
export function otpauthUri(secretBase32: string, label: string, issuer = "Vault Finance"): string {
  const e = encodeURIComponent;
  return (
    `otpauth://totp/${e(issuer)}:${e(label)}` +
    `?secret=${secretBase32}&issuer=${e(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
  );
}
