import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
import type { AppConfig } from "./config.js";

export interface TlsMaterial {
  cert: string;
  key: string;
}

/**
 * Resolve TLS material per ADR-0004: use the user-provided cert/key when
 * configured; otherwise generate a self-signed pair once into the data dir
 * and reuse it on every subsequent boot (a stable fingerprint is what makes
 * the client's trust-on-first-use pinning meaningful).
 */
export function resolveTls(config: AppConfig): TlsMaterial | null {
  if (!config.tls.enabled) return null;

  if (config.tls.certPath && config.tls.keyPath) {
    return {
      cert: readFileSync(config.tls.certPath, "utf8"),
      key: readFileSync(config.tls.keyPath, "utf8"),
    };
  }

  const certPath = path.join(config.dataDir, "tls-cert.pem");
  const keyPath = path.join(config.dataDir, "tls-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  }

  const pems = selfsigned.generate(
    [{ name: "commonName", value: "vault-finance" }],
    {
      days: 3650,
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" }, // DNS
            { type: 7, ip: "127.0.0.1" }, // IP
          ],
        },
      ],
    },
  );

  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}
