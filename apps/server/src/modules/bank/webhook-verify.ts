import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

/**
 * Plaid webhook verification (Plaid docs: "Webhook verification"). Each
 * webhook carries a `Plaid-Verification` header: an ES256 JWT, signed with a
 * key fetched from Plaid by its `kid`, whose `request_body_sha256` claim is
 * the SHA-256 of the exact body bytes. Anything else — no header, another
 * algorithm, an expired key, a token older than five minutes, or a body that
 * doesn't match — is not from Plaid.
 */

export type FetchKey = (keyId: string) => Promise<JWK & { expired_at?: number | null }>;

const MAX_AGE = "5 min";

export async function verifyPlaidWebhook(
  rawBody: Buffer,
  token: string | undefined,
  fetchKey: FetchKey,
): Promise<boolean> {
  if (!token) return false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) return false;
    const jwk = await fetchKey(header.kid);
    if (jwk.expired_at) return false;
    const { expired_at: _e, ...publicJwk } = jwk;
    const key = await importJWK(publicJwk, "ES256");
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"], maxTokenAge: MAX_AGE });

    const claimed = payload["request_body_sha256"];
    if (typeof claimed !== "string") return false;
    const actual = createHash("sha256").update(rawBody).digest("hex");
    const a = Buffer.from(actual, "utf8");
    const b = Buffer.from(claimed.toLowerCase(), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Keys are re-checked with Plaid after this, so a key Plaid expires stops working. */
const KEY_TTL_MS = 24 * 60 * 60_000;

/** Keys by id, so a burst of webhooks costs one key fetch. */
export function cachedKeyFetcher(fetchKey: FetchKey, now: () => number = Date.now): FetchKey {
  type Key = JWK & { expired_at?: number | null };
  const cache = new Map<string, { at: number; key: Promise<Key> }>();
  return (keyId) => {
    const hit = cache.get(keyId);
    if (hit && now() - hit.at < KEY_TTL_MS) return hit.key;
    const key = fetchKey(keyId);
    key.catch(() => cache.delete(keyId));
    cache.set(keyId, { at: now(), key });
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    return key;
  };
}
