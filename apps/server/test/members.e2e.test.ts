import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { MailMessage } from "../src/lib/mailer.js";

/**
 * Household members: a household owner ("sub-admin") can invite by email or
 * create with a temporary password; members can't manage other members; the
 * public invite-accept flow creates a working login.
 */
describe("household members", () => {
  const PG_PORT = 55461;
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let ownerAuth: { authorization: string };
  const sent: MailMessage[] = [];

  const asOwner = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: ownerAuth, payload });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-mem-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-mem-pg-"));
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
        APP_PUBLIC_URL: "https://vault.test:8443",
        UPDATE_CHECK_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    });
    // Capture outbound email instead of sending it.
    app.mailer.send = async (m: MailMessage) => {
      sent.push(m);
    };

    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        ownerEmail: "owner@vault.test",
        ownerPassword: "correct-horse-battery",
        ownerDisplayName: "Pat Owner",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@vault.test",
        password: "correct-horse-battery",
        deviceName: "test",
        platform: "linux",
      },
    });
    ownerAuth = { authorization: `Bearer ${login.json().accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  it("setup sent the owner a household-confirmed email", () => {
    expect(sent.some((m) => m.to === "owner@vault.test" && /set up/i.test(m.subject))).toBe(true);
  });

  it("owner invites a member by email, and the invite can be accepted", async () => {
    sent.length = 0;
    const res = await asOwner("POST", "/api/v1/members/invite", {
      displayName: "Sam Member",
      email: "sam@vault.test",
    });
    expect(res.statusCode).toBe(201);
    const url: string = res.json().inviteUrl;
    expect(url).toContain("/invite?token=");
    const token = new URL(url).searchParams.get("token")!;

    expect(sent.some((m) => m.to === "sam@vault.test")).toBe(true);

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ email: "sam@vault.test", invitedByName: "Pat Owner" });

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}/accept`,
      payload: { password: "sam-strong-password" },
    });
    expect(accept.statusCode).toBe(204);

    // The token is now spent.
    const reuse = await app.inject({
      method: "POST",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}/accept`,
      payload: { password: "another-password" },
    });
    expect(reuse.statusCode).toBe(404);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "sam@vault.test",
        password: "sam-strong-password",
        deviceName: "test",
        platform: "linux",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("member");
  });

  it("owner creates a member with a temporary password (password never emailed)", async () => {
    sent.length = 0;
    const res = await asOwner("POST", "/api/v1/members", {
      displayName: "Jo Member",
      email: "jo@vault.test",
      tempPassword: "temp-password-123",
    });
    expect(res.statusCode).toBe(201);
    const mail = sent.find((m) => m.to === "jo@vault.test");
    expect(mail).toBeDefined();
    expect(mail!.text).not.toContain("temp-password-123");
    expect(mail!.html).not.toContain("temp-password-123");

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "jo@vault.test",
        password: "temp-password-123",
        deviceName: "test",
        platform: "linux",
      },
    });
    expect(login.statusCode).toBe(200);
  });

  it("a member cannot manage members", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "jo@vault.test",
        password: "temp-password-123",
        deviceName: "test",
        platform: "linux",
      },
    });
    const memberAuth = { authorization: `Bearer ${login.json().accessToken}` };
    const list = await app.inject({ method: "GET", url: "/api/v1/members", headers: memberAuth });
    expect(list.statusCode).toBe(403);
    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/members/invite",
      headers: memberAuth,
      payload: { displayName: "X", email: "x@vault.test" },
    });
    expect(invite.statusCode).toBe(403);
  });

  it("owner lists members + pending invites, and can revoke a pending invite", async () => {
    await asOwner("POST", "/api/v1/members/invite", {
      displayName: "Temp Invite",
      email: "temp@vault.test",
    });
    const list = await asOwner("GET", "/api/v1/members");
    const body = list.json();
    expect(body.members.length).toBeGreaterThanOrEqual(3); // owner + sam + jo
    const pending = body.invites.find((i: { email: string }) => i.email === "temp@vault.test");
    expect(pending).toBeDefined();

    const del = await asOwner("DELETE", `/api/v1/members/${pending.id}`);
    expect(del.statusCode).toBe(204);
    const after = await asOwner("GET", "/api/v1/members");
    expect(after.json().invites.some((i: { email: string }) => i.email === "temp@vault.test")).toBe(false);
  });

  it("the owner account cannot be removed", async () => {
    const list = await asOwner("GET", "/api/v1/members");
    const owner = list.json().members.find((m: { role: string }) => m.role === "owner");
    const res = await asOwner("DELETE", `/api/v1/members/${owner.id}`);
    expect(res.statusCode).toBe(400);
  });
});
