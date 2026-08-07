import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Envelope encryption for the handful of columns that hold real secrets:
 * `users.totp_secret`, `bank_settings.plaid_secret`, `ai_settings.api_key`.
 *
 * Why, given the docs already recommend a LUKS volume: a `pg_dump` backup —
 * the procedure in docs/operations.md §5 — copies those columns *off* the
 * encrypted volume in the clear. A plaintext TOTP secret in a backup file
 * silently defeats the second factor. Encrypting at the column level keeps the
 * secret useless without the key file, which lives outside the dump.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. AES-256-GCM, fresh
 * 12-byte IV per value. The version prefix makes the value self-describing, so
 * `decryptSecret` can pass through legacy plaintext untouched and rows migrate
 * lazily as they're rewritten (plus an eager pass at boot — see
 * `encryptExistingSecrets`).
 */

const PREFIX = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

let key: Buffer | null = null;

/**
 * Load (or create) the data key. Mirrors `loadOrCreateJwtSecret` in config.ts:
 * a 0600 file in the data dir, overridable by env for external key management.
 *
 * Must be called before any encrypt/decrypt. Not lazy on purpose — a missing
 * key should fail at boot, never silently at the moment a secret is written.
 */
export function configureSecretCrypto(dataDir: string, envKey?: string | undefined): void {
  if (envKey) {
    const raw = Buffer.from(envKey, "base64");
    if (raw.length !== KEY_BYTES) {
      throw new Error(`VAULT_DATA_KEY must be ${KEY_BYTES} base64-encoded bytes`);
    }
    key = raw;
    return;
  }
  const keyPath = path.join(dataDir, "data-key");
  if (existsSync(keyPath)) {
    key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`${keyPath} is corrupt — expected ${KEY_BYTES} bytes`);
    }
    return;
  }
  const fresh = randomBytes(KEY_BYTES);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(keyPath, fresh.toString("base64"), { mode: 0o600 });
  key = fresh;
}

/** Test seam: configure with a known key. */
export function configureSecretCryptoWithKey(raw: Buffer): void {
  if (raw.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  key = raw;
}

function requireKey(): Buffer {
  if (!key) {
    throw new Error("secret crypto not configured — call configureSecretCrypto() at startup");
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

/** Encrypt a secret for storage. Null/empty pass through unchanged. */
export function encryptSecret<T extends string | null | undefined>(plaintext: T): T {
  if (plaintext == null || plaintext === "") return plaintext;
  const k = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".") as T;
}

/**
 * Decrypt a stored secret. A value without the version prefix is legacy
 * plaintext and is returned as-is, so a database written before this change
 * keeps working and migrates as rows are rewritten.
 */
export function decryptSecret<T extends string | null | undefined>(stored: T): T {
  if (stored == null || stored === "") return stored;
  if (!isEncrypted(stored)) return stored;
  const parts = stored.split(".");
  if (parts.length !== 4) throw new Error("malformed encrypted secret");
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    requireKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return out.toString("utf8") as T;
}
