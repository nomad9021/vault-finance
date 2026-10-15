#!/usr/bin/env node
/**
 * Server console for device approval (ADR-0009). Runs inside the server
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
`;

function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—";
}

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
