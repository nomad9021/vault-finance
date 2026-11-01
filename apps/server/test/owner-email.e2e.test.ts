import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

// Stand in for the mail provider; everything up to the network call is real.
const smtp = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  mails: [] as Array<Record<string, unknown>>,
  verifyError: null as Error | null,
  sendError: null as Error | null,
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      smtp.options.push(options);
      return {
        verify: async () => {
          if (smtp.verifyError) throw smtp.verifyError;
          return true;
        },
        sendMail: async (mail: Record<string, unknown>) => {
          if (smtp.sendError) throw smtp.sendError;
          smtp.mails.push(mail);
        },
      };
    },
  },
}));

const codeError = (code: string) => Object.assign(new Error(`raw provider detail ${code}`), { code });

/**
 * Invitations sent from the owner's own connected mailbox, with no server-wide
 * SMTP relay: the app never claims an email went out when it didn't.
 */
describe("owner email invitations", () => {
  const PG_PORT = 55487;
  const APP_PASSWORD = "abcd efgh ijkl mnop";
  let pg: EmbeddedPostgres;
  let app: FastifyInstance;
  let dataDir: string;
  let pgDir: string;
  let ownerAuth: { authorization: string };

  const asOwner = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: ownerAuth, payload });
  const connectGmail = () =>
    asOwner("POST", "/api/v1/members/email", { email: "Pat@Gmail.com", password: APP_PASSWORD });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "vault-mail-data-"));
    pgDir = mkdtempSync(path.join(tmpdir(), "vault-mail-pg-"));
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
        LOG_LEVEL: "fatal",
        UPDATE_CHECK_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    });

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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    smtp.options.length = 0;
    smtp.mails.length = 0;
    smtp.verifyError = null;
    smtp.sendError = null;
  });

  it("with nothing connected, says no email was sent instead of claiming success", async () => {
    const res = await asOwner("POST", "/api/v1/members/invite", {
      email: "first@vault.test",
      serverUrl: "https://192.168.1.10:8443",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: false, sentFrom: null });
    expect(res.json().emailProblem).toContain("No email account is connected");
    expect(res.json().inviteUrl).toMatch(/^https:\/\/192\.168\.1\.10:8443\/invite\?token=/);
    expect(smtp.mails).toHaveLength(0);
  });

  it("a rejected sign-in explains the app password and saves nothing", async () => {
    smtp.verifyError = codeError("EAUTH");
    const res = await connectGmail();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("app password");
    expect(res.body).not.toContain("raw provider detail");
    const status = await asOwner("GET", "/api/v1/members/email");
    expect(status.json().connected).toBe(false);
  });

  it("an unknown provider asks for its mail server", async () => {
    const res = await asOwner("POST", "/api/v1/members/email", {
      email: "pat@example.org",
      password: APP_PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("mail server");
  });

  it("connects a mailbox over TLS, encrypting the password and never returning it", async () => {
    const res = await connectGmail();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, fromEmail: "pat@gmail.com", serverMailAvailable: false });
    expect(res.body).not.toContain("abcd");

    expect(smtp.options[0]).toMatchObject({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "pat@gmail.com", pass: "abcdefghijklmnop" },
    });

    const row = await app.db.query.ownerEmail.findFirst();
    expect(row?.password).not.toContain("abcdefghijklmnop");
  });

  it("an email-only invite comes from the owner's address and can be accepted with a chosen name", async () => {
    const res = await asOwner("POST", "/api/v1/members/invite", {
      email: "Sam@Vault.test",
      serverUrl: "https://100.64.0.5:8443/",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: true, sentFrom: "pat@gmail.com", emailProblem: null });

    expect(smtp.mails).toHaveLength(1);
    const mail = smtp.mails[0]!;
    expect(mail["from"]).toEqual({ name: "Pat Owner", address: "pat@gmail.com" });
    expect(mail["to"]).toBe("sam@vault.test");
    expect(mail["text"]).toContain(res.json().inviteUrl);
    expect(mail["text"]).toContain("private network");

    const token = new URL(res.json().inviteUrl).searchParams.get("token")!;
    expect(new URL(res.json().inviteUrl).origin).toBe("https://100.64.0.5:8443");

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}`,
    });
    expect(preview.json()).toMatchObject({ displayName: "sam", email: "sam@vault.test" });

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}/accept`,
      payload: { password: "a-brand-new-password", displayName: "Sam Carter" },
    });
    expect(accept.statusCode).toBe(204);
    const list = await asOwner("GET", "/api/v1/members");
    expect(list.json().members.some((m: { displayName: string }) => m.displayName === "Sam Carter")).toBe(true);
  });

  it("a link-only invite emails nobody, even with a mailbox connected", async () => {
    const res = await asOwner("POST", "/api/v1/members/invite", {
      email: "linkonly@vault.test",
      serverUrl: "https://192.168.1.10:8443",
      sendEmail: false,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: false, sentFrom: null, emailProblem: null });
    expect(smtp.mails).toHaveLength(0);

    const token = new URL(res.json().inviteUrl).searchParams.get("token")!;
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}`,
    });
    expect(preview.json()).toMatchObject({ email: "linkonly@vault.test" });
  });

  it("a failed send is reported, and the invite link still works", async () => {
    smtp.sendError = codeError("ECONNECTION");
    const res = await asOwner("POST", "/api/v1/members/invite", {
      email: "fail@vault.test",
      serverUrl: "https://192.168.1.10:8443",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: false, sentFrom: null });
    expect(res.json().emailProblem).toContain("Couldn't reach");
    expect(res.body).not.toContain("raw provider detail");

    const token = new URL(res.json().inviteUrl).searchParams.get("token")!;
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/members/invite/${encodeURIComponent(token)}`,
    });
    expect(preview.statusCode).toBe(200);
  });

  it("won't email a loopback link nobody else could open", async () => {
    const res = await asOwner("POST", "/api/v1/members/invite", {
      email: "local@vault.test",
      serverUrl: "https://localhost:8443",
    });
    expect(res.json().emailed).toBe(false);
    expect(res.json().emailProblem).toContain("local address");
    expect(res.json().inviteUrl).not.toContain("localhost");
    expect(smtp.mails).toHaveLength(0);
  });

  it("only the owner can see or change the connected email, and it can be disconnected", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/members/email" });
    expect(anon.statusCode).toBe(401);

    const res = await asOwner("POST", "/api/v1/members/email/disconnect");
    expect(res.json().connected).toBe(false);
    expect(await app.db.query.ownerEmail.findFirst()).toBeUndefined();
  });
});
