import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  // Postgres
  DATABASE_URL: z
    .string()
    .default("postgres://vault:vault@localhost:5432/vault"),

  // HTTP
  VAULT_PORT: z.coerce.number().int().default(8443),
  VAULT_HOST: z.string().default("0.0.0.0"),

  // TLS: paths to a cert/key pair. When unset, a self-signed pair is
  // generated into VAULT_DATA_DIR on first boot (ADR-0004). VAULT_TLS=off is
  // for local development and tests only.
  VAULT_TLS: z.enum(["on", "off"]).default("on"),
  VAULT_TLS_CERT: z.string().optional(),
  VAULT_TLS_KEY: z.string().optional(),

  // Data dir: generated TLS certs, JWT secret, uploaded attachments.
  VAULT_DATA_DIR: z.string().default("./data"),

  // Auth. If unset, a random secret is generated and persisted in the data
  // dir so restarts don't invalidate sessions.
  VAULT_JWT_SECRET: z.string().min(32).optional(),
  VAULT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),

  // Column-encryption key (32 bytes, base64) for stored secrets. If unset, one
  // is generated and persisted as `data-key` in the data dir. Set this to keep
  // the key in a secrets manager instead of on the volume.
  VAULT_DATA_KEY: z.string().optional(),

  // Extra browser origins allowed to read API responses. Loopback is always
  // allowed; native clients send no Origin and are unaffected.
  VAULT_CORS_ORIGINS: z.string().optional(),

  // Ollama defaults used when the setup wizard doesn't override them.
  OLLAMA_HOST: z.string().default("ollama"),
  OLLAMA_PORT: z.coerce.number().int().default(11434),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),

  // Optional override of the Plaid API base URL (e.g. a mock server in tests).
  // When unset, the plaid provider derives it from the connection's env.
  PLAID_BASE_URL: z.string().optional(),

  // Background auto-sync of bank connections, in minutes. 0 disables it (the
  // default, and what tests use). The Docker compose sets a live value.
  BANK_AUTO_SYNC_MINUTES: z.coerce.number().int().min(0).default(0),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  tls: { enabled: boolean; certPath?: string; keyPath?: string };
  dataDir: string;
  jwtSecret: string;
  /** Base64 column-encryption key; undefined means "use the data-dir file". */
  dataKey?: string;
  /** Additional allowed browser origins (loopback is always permitted). */
  corsOrigins: string[];
  accessTokenTtlSeconds: number;
  ollama: { host: string; port: number; model: string };
  plaidBaseUrl?: string;
  bankAutoSyncMinutes: number;
  logLevel: string;
  /** Shared semver for the version-compatibility check. */
  apiVersion: string;
  minClientVersion: string;
}

function loadOrCreateJwtSecret(dataDir: string): string {
  const secretPath = path.join(dataDir, "jwt-secret");
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim();
  }
  const secret = randomBytes(48).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const dataDir = path.resolve(parsed.VAULT_DATA_DIR);

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.VAULT_PORT,
    host: parsed.VAULT_HOST,
    tls: {
      enabled: parsed.VAULT_TLS === "on",
      ...(parsed.VAULT_TLS_CERT ? { certPath: parsed.VAULT_TLS_CERT } : {}),
      ...(parsed.VAULT_TLS_KEY ? { keyPath: parsed.VAULT_TLS_KEY } : {}),
    },
    dataDir,
    jwtSecret: parsed.VAULT_JWT_SECRET ?? loadOrCreateJwtSecret(dataDir),
    ...(parsed.VAULT_DATA_KEY ? { dataKey: parsed.VAULT_DATA_KEY } : {}),
    corsOrigins: (parsed.VAULT_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    accessTokenTtlSeconds: parsed.VAULT_ACCESS_TOKEN_TTL_SECONDS,
    ollama: {
      host: parsed.OLLAMA_HOST,
      port: parsed.OLLAMA_PORT,
      model: parsed.OLLAMA_MODEL,
    },
    ...(parsed.PLAID_BASE_URL ? { plaidBaseUrl: parsed.PLAID_BASE_URL } : {}),
    bankAutoSyncMinutes: parsed.BANK_AUTO_SYNC_MINUTES,
    logLevel: parsed.LOG_LEVEL,
    apiVersion: "0.1.2",
    minClientVersion: "0.1.0",
  };
}
