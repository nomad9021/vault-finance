// Local dev stack without Docker: embedded Postgres + the built server with
// TLS off, for browser-mode frontend development and verification.
//
//   node scripts/dev-stack.mjs [--port 8787] [--fresh]
//
// State lives in .dev-stack/ (gitignored). --fresh wipes it first.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.join(repo, "apps/server");
const stateDir = path.join(repo, ".dev-stack");
const pgDir = path.join(stateDir, "pg");
const dataDir = path.join(stateDir, "data");

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 8787;
const pgPort = port + 1;

if (args.includes("--fresh") && existsSync(stateDir)) {
  rmSync(stateDir, { recursive: true, force: true });
}
const freshPg = !existsSync(pgDir);
mkdirSync(pgDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const { default: EmbeddedPostgres } = await import(
  path.join(serverDir, "node_modules/embedded-postgres/dist/index.js")
);

const pg = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: "vault",
  password: "vault",
  port: pgPort,
  persistent: true,
});

if (freshPg) await pg.initialise();
await pg.start();
if (freshPg) await pg.createDatabase("vault");
console.log(`[dev-stack] postgres on :${pgPort} (${freshPg ? "fresh" : "existing"} data)`);

const server = spawn("node", ["dist/server.js"], {
  cwd: serverDir,
  env: {
    ...process.env,
    DATABASE_URL: `postgres://vault:vault@localhost:${pgPort}/vault`,
    VAULT_TLS: "off", // browser dev mode; the Tauri app uses HTTPS+pinning
    VAULT_PORT: String(port),
    VAULT_HOST: "127.0.0.1",
    VAULT_DATA_DIR: dataDir,
    LOG_LEVEL: "info",
  },
  stdio: "inherit",
});
console.log(`[dev-stack] api on http://127.0.0.1:${port}`);

async function shutdown() {
  server.kill("SIGTERM");
  await pg.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
