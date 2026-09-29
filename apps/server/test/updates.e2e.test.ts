import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { MailMessage } from "../src/lib/mailer.js";
import {
  getNotifiedVersion,
  refreshUpdateStatus,
} from "../src/modules/updates/service.js";
import { updateAvailable } from "../src/lib/email-templates.js";

describe("update checking", () => {
  const PG_PORT = 55462;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let auth: { authorization: string };
  let manifest: Server;
  let manifestUrl: string;
  let latestTag = "v0.1.3"; // same as apiVersion → no update
  const sent: MailMessage[] = [];

  beforeAll(async () => {
    manifest = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tag_name: latestTag, html_url: "https://example.test/notes" }));
    });
    await new Promise<void>((r) => manifest.listen(0, "127.0.0.1", r));
    const addr = manifest.address();
    if (typeof addr === "object" && addr) manifestUrl = `http://127.0.0.1:${addr.port}/latest`;

    dataDir = mkdtempSync(path.join(tmpdir(), "vault-upd-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-upd-pg-"));
    pg = new EmbeddedPostgres({
      databaseDir: pgDir,
      user: "vault",
      password: "vault",
      port: PG_PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("vault");

    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
        VAULT_TLS: "off",
        VAULT_DATA_DIR: dataDir,
        LOG_LEVEL: "error",
        UPDATE_CHECK_ENABLED: "false", // scheduler off; we drive the service directly
        UPDATE_MANIFEST_URL: manifestUrl,
      } as NodeJS.ProcessEnv),
    });
    app.mailer.send = async (m: MailMessage) => {
      sent.push(m);
    };

    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        ownerEmail: "owner@vault.test",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Owner",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@vault.test",
        password: "correct-horse-battery",
        deviceName: "t",
        platform: "linux",
      },
    });
    auth = { authorization: `Bearer ${login.json().accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
    await new Promise<void>((r) => manifest.close(() => r()));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  it("reports no update when the latest release matches the running version", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/updates/status", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentVersion).toBe("0.1.3");
    expect(body.latestVersion).toBe("0.1.3");
    expect(body.updateAvailable).toBe(false);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/updates/status" });
    expect(res.statusCode).toBe(401);
  });

  it("detects a newer release through the status endpoint", async () => {
    latestTag = "v0.9.0";
    const cfg = loadConfig({
      DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
      UPDATE_MANIFEST_URL: manifestUrl,
    } as NodeJS.ProcessEnv);
    const status = await refreshUpdateStatus(app.db, cfg, app.log);
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("0.9.0");
    expect(status.notesUrl).toBe("https://example.test/notes");

    // The email body carries upgrade instructions.
    const body = updateAvailable({
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion!,
      operatorManaged: false,
    });
    expect(body.text).toContain("vault-update");

    // Recording the notified version is the scheduler's job — not done here.
    expect(await getNotifiedVersion(app.db)).toBeNull();
  });
});
