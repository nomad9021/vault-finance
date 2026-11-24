#!/usr/bin/env node
// Builds crates/vault-ui to WebAssembly into apps/desktop/src/rust/pkg, where
// RustPage.tsx imports it. Run by the desktop `dev` and `build` scripts.
//   --dev   unoptimized, faster to build
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dev = process.argv.includes("--dev");

execFileSync(process.execPath, [`${root}scripts/gen-rust-icons.mjs`], { stdio: "inherit" });
try {
  execFileSync(
    "wasm-pack",
    [
      "build", `${root}crates/vault-ui`,
      "--target", "web",
      "--out-dir", `${root}apps/desktop/src/rust/pkg`,
      "--out-name", "vault_ui",
      "--no-pack",
      dev ? "--dev" : "--release",
    ],
    { stdio: "inherit" },
  );
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(
      "wasm-pack not found. Install the Rust UI toolchain once:\n" +
        "  rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked",
    );
  }
  process.exit(1);
}
