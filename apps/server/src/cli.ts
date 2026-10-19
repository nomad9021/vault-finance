#!/usr/bin/env node
/**
 * Server console for device approval (ADR-0009) and secret rotation. Runs inside the server
 * container, so having shell access to the server is the credential:
 *
 *   docker compose exec server vault pending
 *   docker compose exec server vault approve 482913
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema.js";
import type { Db } from "./plugins/db.js";
import * as devices from "./modules/devices/service.js";
import { otherConnections, rotateDataKey, rotateJwtSecret, signOutEveryone } from "./rotate.js";

const HELP = `Vault Finance server console — device approval

  vault pending                    sign-ins waiting for approval, with their codes
  vault approve <code>             let that device in
  vault approve <code> --override  same, even when console approval is turned off
                                   (recovery if you're locked out of every device)
  vault deny <code>                refuse it
  vault devices                    approved devices
  vault revoke <device-id>         remove a device's approval and sign it out
  vault methods                    show which approval methods are allowed
  vault methods device=on|off console=on|off
                                   change them (at least one stays on)

Rotating secrets (when one is, or may have been, exposed):
  vault sign-out-everyone          end every sign-in and delete biometric keys
  vault rotate-jwt-secret          new token-signing secret (restart the server after)
  vault rotate-data-key            re-encrypt stored secrets under a new key
                                   (stop the server first — see docs/operations.md)
`;

function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—";
}

const dataDir = () => process.env["VAULT_DATA_DIR"] ?? "/data";

async function run(db: Db, args: string[]): Promise<number> {
  const [cmd, arg] = args;
  switch (cmd) {
    case "pending": {
      const list = await devices.listPending(db, null);
      if (list.length === 0) {
        console.log("No sign-ins are waiting for approval.");
        return 0;
      }
      for (const p of list) {
        console.log(
          `${p.code ?? "------"}  ${p.userDisplayName} · ${p.deviceName} (${p.platform})` +
            `${p.ipAddress ? ` from ${p.ipAddress}` : ""} · expires ${when(p.expiresAt)}`,
        );
      }
      console.log(`\nApprove with: vault approve <code>`);
      return 0;
    }
    case "approve": {
      if (!arg) break;
      const r = await devices.approveFromConsole(db, arg, { override: args.includes("--override") });
      console.log(`Approved: ${r.userDisplayName} · ${r.deviceName}. It will finish signing in by itself.`);
      return 0;
    }
    case "deny": {
      if (!arg) break;
      await devices.denyFromConsole(db, arg);
      console.log("Denied.");
      return 0;
    }
    case "devices": {
      const list = await devices.listTrusted(db, null, null);
      for (const d of list) {
        console.log(
          `${d.id}  ${d.userDisplayName} · ${d.deviceName} (${d.platform}) · approved ${when(d.approvedAt)}` +
            ` via ${d.approvedVia ?? "?"} · last seen ${when(d.lastSeenAt)}`,
        );
      }
      if (list.length === 0) console.log("No approved devices.");
      return 0;
    }
    case "revoke": {
      if (!arg) break;
      await devices.revokeDevice(db, null, arg);
      console.log("Revoked — that device is signed out and must be approved again.");
      return 0;
    }
    case "methods": {
      const current = await devices.getMethods(db);
      const next = { ...current };
      for (const a of args.slice(1)) {
        const m = /^(device|console)=(on|off)$/.exec(a);
        if (!m) {
          console.error(`Unknown setting: ${a}`);
          return 2;
        }
        if (m[1] === "device") next.trustedDevice = m[2] === "on";
        else next.serverConsole = m[2] === "on";
      }
      const shown = args.length > 1 ? await devices.setMethods(db, next) : current;
      console.log(`Approve from a trusted device: ${shown.trustedDevice ? "on" : "off"}`);
      console.log(`Approve on the server console: ${shown.serverConsole ? "on" : "off"}`);
      return 0;
    }
    case "sign-out-everyone": {
      const n = await signOutEveryone(db);
      console.log(`Ended ${n.sessions} sign-in(s) and deleted ${n.deviceKeys} biometric key(s). Everyone signs in again with their password.`);
      return 0;
    }
    case "rotate-jwt-secret": {
      if (process.env["VAULT_JWT_SECRET"]) {
        console.error("VAULT_JWT_SECRET is set in the environment — change it there (openssl rand -base64 48), then restart the server.");
        return 2;
      }
      rotateJwtSecret(dataDir());
      console.log("New token-signing secret written. Restart the server now: docker compose restart server");
      return 0;
    }
    case "rotate-data-key": {
      const others = await otherConnections(db);
      if (others > 0 && arg !== "--force") {
        console.error(
          `The server is still connected to the database (${others} connection(s)). Stop it first, so nothing is written with the old key:\n` +
            "  docker compose stop server\n" +
            "  docker compose run --rm --no-deps server vault rotate-data-key\n" +
            "  docker compose start server",
        );
        return 2;
      }
      const r = await rotateDataKey(db, dataDir(), process.env["VAULT_DATA_KEY"]);
      console.log(`Re-encrypted ${r.rotated} secret(s) under a new data key.`);
      if (r.newKeyForEnv) {
        console.log(`Set VAULT_DATA_KEY to this new value before starting the server:\n  ${r.newKeyForEnv}`);
      }
      return 0;
    }
  }
  console.log(HELP);
  return cmd && !["help", "--help", "-h"].includes(cmd) ? 2 : 0;
}

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL isn't set. Run this inside the server container: docker compose exec server vault …");
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  process.exitCode = await run(drizzle(sql, { schema }), process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
