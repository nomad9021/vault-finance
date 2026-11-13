// iPhone design preview in a desktop browser, with demo data and no login.
//
//   node scripts/phone-preview.mjs [--fresh]
//   → http://127.0.0.1:5174/preview.html
//
// Runs its own demo server (state in .dev-stack-preview/, gitignored; --fresh
// starts it over), seeds it once, and starts Vite with the preview sign-in.
// The preview device is the owner's first device on that server, so it's
// approved automatically. Everything is local and fake; dev only.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const state = path.join(repo, ".dev-stack-preview");
const API_PORT = 8797;
const WEB_PORT = 5174;
const EMAIL = "alex@example.com";
const PASSWORD = "a-long-enough-password";

if (process.argv.includes("--fresh")) rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

// One identity for the seed script and the app, so both are the same device.
const identityFile = path.join(state, "device.json");
if (!existsSync(identityFile)) {
  writeFileSync(
    identityFile,
    JSON.stringify({ deviceId: randomUUID(), deviceSecret: randomBytes(32).toString("base64url") }),
    { mode: 0o600 },
  );
}
const device = JSON.parse(readFileSync(identityFile, "utf8"));

const children = [];
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const api = spawn(
  "node",
  [path.join(repo, "scripts/dev-stack.mjs"), "--port", String(API_PORT), "--state", ".dev-stack-preview"],
  { cwd: repo, stdio: "inherit" },
);
children.push(api);
api.on("exit", (code) => {
  console.error(`[phone-preview] demo server stopped (${code})`);
  stop();
});

const base = `http://127.0.0.1:${API_PORT}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/api/v1/version`)).ok) break;
  } catch {}
  if (i > 60) throw new Error("demo server didn't start");
  await new Promise((r) => setTimeout(r, 1000));
}

const seed = spawnSync("node", [path.join(repo, "scripts/seed-demo.mjs")], {
  cwd: repo,
  stdio: "inherit",
  env: {
    ...process.env,
    VAULT_URL: base,
    VAULT_EMAIL: EMAIL,
    VAULT_PASSWORD: PASSWORD,
    VAULT_DEVICE_ID: device.deviceId,
    VAULT_DEVICE_SECRET: device.deviceSecret,
  },
});
if (seed.status !== 0) console.error("[phone-preview] seeding failed; the preview may be empty");

const web = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(WEB_PORT)], {
  cwd: path.join(repo, "apps/desktop"),
  stdio: "inherit",
  env: {
    ...process.env,
    VAULT_SERVER: base,
    VITE_PREVIEW_EMAIL: EMAIL,
    VITE_PREVIEW_PASSWORD: PASSWORD,
    VITE_PREVIEW_DEVICE_ID: device.deviceId,
    VITE_PREVIEW_DEVICE_SECRET: device.deviceSecret,
  },
});
children.push(web);
console.log(`[phone-preview] open http://127.0.0.1:${WEB_PORT}/preview.html`);
