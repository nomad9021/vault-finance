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

  // ── Separate AI server on Proxmox (optional) ──
  // With all four set, the assistant shows whether the AI server's VM is on
  // and can start it. The token needs only VM.Audit + VM.PowerMgmt on that VM
  // (see docs/self-hosting.md). FINGERPRINT pins Proxmox's self-signed
  // certificate (SHA-256, as Proxmox shows it); leave it blank only if the
  // Proxmox API has a publicly trusted certificate.
  AI_HOST_PROXMOX_URL: z.string().url().optional().or(z.literal("")),
  AI_HOST_PROXMOX_NODE: z.string().optional(),
  AI_HOST_VMID: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
  AI_HOST_PROXMOX_TOKEN: z.string().optional(),
  AI_HOST_PROXMOX_FINGERPRINT: z.string().optional(),

  // Optional override of the Plaid API base URL (e.g. a mock server in tests).
  // When unset, the plaid provider derives it from the connection's env.
  PLAID_BASE_URL: z.string().optional(),

  // Background auto-sync of bank connections, in minutes. 0 disables it (the
  // default, and what tests use). The Docker compose sets a live value.
  BANK_AUTO_SYNC_MINUTES: z.coerce.number().int().min(0).default(0),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ── Outbound email (SMTP) ──
  // All optional: with SMTP_HOST unset the mailer is a no-op (logs a warning
  // once and drops the message) so a server with no mail relay still runs.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // true = implicit TLS (port 465); false = STARTTLS upgrade (port 587).
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  MAIL_FROM: z.string().optional(),
  // Public base URL of this server, used to build links in emails
  // (e.g. https://smith.vault.example.com or https://192.168.1.10:8443).
  APP_PUBLIC_URL: z.string().optional(),
  // Optional post-onboarding feedback survey; the welcome email links it when set.
  SURVEY_URL: z.string().optional(),

  // ── Update checking ──
  UPDATE_CHECK_ENABLED: z.enum(["true", "false"]).default("true"),
  UPDATE_MANIFEST_URL: z
    .string()
    .default("https://api.github.com/repos/nomad9021/vault-finance/releases/latest"),
  UPDATE_CHECK_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
  // Set true on operator-managed fleets so the "update available" email tells
  // owners to contact their admin rather than run vault-update themselves.
  UPDATE_OPERATOR_MANAGED: z.enum(["true", "false"]).default("false"),
  // Folder shared with the host's update agent (enable-app-updates.sh). Unset
  // = no in-app updating; the app shows the vault-update instructions instead.
  UPDATE_AGENT_DIR: z.string().optional(),
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
  /** Proxmox VM running the separate AI server; undefined ⇒ power control off. */
  aiHost?: {
    proxmoxUrl: string;
    node: string;
    vmid: number;
    /** "user@realm!tokenid=secret" */
    token: string;
    fingerprint?: string;
  };
  plaidBaseUrl?: string;
  bankAutoSyncMinutes: number;
  logLevel: string;
  /** Shared semver for the version-compatibility check. */
  apiVersion: string;
  minClientVersion: string;
  /** Outbound email. `host` undefined ⇒ mailer is a no-op. */
  mail: {
    host?: string;
    port: number;
    user?: string;
    pass?: string;
    secure: boolean;
    from: string;
    appPublicUrl?: string;
    surveyUrl?: string;
  };
  updates: {
    enabled: boolean;
    manifestUrl: string;
    intervalHours: number;
    operatorManaged: boolean;
    agentDir: string | null;
  };
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
    ...(parsed.AI_HOST_PROXMOX_URL && parsed.AI_HOST_PROXMOX_NODE && parsed.AI_HOST_VMID && parsed.AI_HOST_PROXMOX_TOKEN
      ? {
          aiHost: {
            proxmoxUrl: parsed.AI_HOST_PROXMOX_URL.replace(/\/+$/, ""),
            node: parsed.AI_HOST_PROXMOX_NODE,
            vmid: parsed.AI_HOST_VMID,
            token: parsed.AI_HOST_PROXMOX_TOKEN,
            ...(parsed.AI_HOST_PROXMOX_FINGERPRINT ? { fingerprint: parsed.AI_HOST_PROXMOX_FINGERPRINT } : {}),
          },
        }
      : {}),
    ...(parsed.PLAID_BASE_URL ? { plaidBaseUrl: parsed.PLAID_BASE_URL } : {}),
    bankAutoSyncMinutes: parsed.BANK_AUTO_SYNC_MINUTES,
    logLevel: parsed.LOG_LEVEL,
    apiVersion: "0.1.7",
    minClientVersion: "0.1.5",
    mail: {
      ...(parsed.SMTP_HOST ? { host: parsed.SMTP_HOST } : {}),
      port: parsed.SMTP_PORT,
      ...(parsed.SMTP_USER ? { user: parsed.SMTP_USER } : {}),
      ...(parsed.SMTP_PASS ? { pass: parsed.SMTP_PASS } : {}),
      secure: parsed.SMTP_SECURE === "true",
      from: parsed.MAIL_FROM ?? "Vault Finance <no-reply@vault.local>",
      ...(parsed.APP_PUBLIC_URL ? { appPublicUrl: parsed.APP_PUBLIC_URL.replace(/\/+$/, "") } : {}),
      ...(parsed.SURVEY_URL ? { surveyUrl: parsed.SURVEY_URL } : {}),
    },
    updates: {
      enabled: parsed.UPDATE_CHECK_ENABLED === "true",
      manifestUrl: parsed.UPDATE_MANIFEST_URL,
      intervalHours: parsed.UPDATE_CHECK_INTERVAL_HOURS,
      operatorManaged: parsed.UPDATE_OPERATOR_MANAGED === "true",
      agentDir: parsed.UPDATE_AGENT_DIR ? path.resolve(parsed.UPDATE_AGENT_DIR) : null,
    },
  };
}
