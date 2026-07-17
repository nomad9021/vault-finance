// One semantic version across server and clients (spec requirement — the
// /api/v1/version compatibility gate depends on it). Updates every place the
// version literal lives, then prints what changed:
//
//   node scripts/set-version.mjs 0.2.0
//
// Release flow (docs/releasing.md): run this, commit, tag v0.2.0, push.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const edit = (file, transform) => {
  const p = path.join(repo, file);
  const before = readFileSync(p, "utf8");
  const after = transform(before);
  if (before === after) {
    console.error(`WARNING: no change in ${file} — pattern drift? Fix set-version.mjs.`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(p, after);
  console.log(`✓ ${file}`);
};

const jsonVersion = (text) =>
  text.replace(/"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`);

// Package manifests (root + apps; workspace packages stay 0.1.0 — they're
// internal and never published).
edit("package.json", jsonVersion);
edit("apps/server/package.json", jsonVersion);
edit("apps/desktop/package.json", jsonVersion);

// Tauri bundle + updater version.
edit("apps/desktop/src-tauri/tauri.conf.json", jsonVersion);
edit("apps/desktop/src-tauri/Cargo.toml", (t) =>
  t.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${version}"`),
);

// Server API version (what /api/v1/version reports).
edit("apps/server/src/config.ts", (t) =>
  t.replace(/apiVersion: "\d+\.\d+\.\d+"/, `apiVersion: "${version}"`),
);

// Desktop client version (sent as X-Client-Version on every request).
edit("apps/desktop/src/state/store.ts", (t) =>
  t.replace(/APP_VERSION = "\d+\.\d+\.\d+"/, `APP_VERSION = "${version}"`),
);

console.log(`\nAll set to ${version}. Note: minClientVersion in
apps/server/src/config.ts is NOT bumped automatically — raise it manually
only when a release actually breaks older clients.`);
