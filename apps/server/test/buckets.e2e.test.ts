import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/** Savings buckets: dividing an account's balance into named parts. */

const PG_PORT = 55530;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dirs: string[] = [];
let auth: { authorization: string };
const api = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: auth, ...(payload ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.statusCode === 204 ? null : r.json() };
};

beforeAll(async () => {
  dirs = [mkdtempSync(path.join(tmpdir(), "vault-bk-pg-")), mkdtempSync(path.join(tmpdir(), "vault-bk-data-"))];
  pg = new EmbeddedPostgres({ databaseDir: dirs[0]!, user: "vault", password: "vault", port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vault");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`, VAULT_TLS: "off", VAULT_DATA_DIR: dirs[1], LOG_LEVEL: "error" } as NodeJS.ProcessEnv) });
  await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: { ownerEmail: "b@b.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "B" } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "b@b.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("savings buckets", () => {
  let savings: string;
  let card: string;
  let emergency: string;
  let vacation: string;

  it("divides a savings balance and shows what's unassigned", async () => {
    savings = (await api("POST", "/accounts", { name: "High-yield savings", type: "savings", balanceCents: 1_000_000 })).body.id;
    card = (await api("POST", "/accounts", { name: "Visa", type: "credit_card", balanceCents: -50_000 })).body.id;
    emergency = (await api("POST", "/buckets", { accountId: savings, name: "Emergency", allocatedCents: 600_000, targetCents: 900_000 })).body.id;
    vacation = (await api("POST", "/buckets", { accountId: savings, name: "Vacation", allocatedCents: 150_000 })).body.id;
    const { body } = await api("GET", "/buckets");
    const acct = body.accounts.find((a: { accountId: string }) => a.accountId === savings);
    expect(acct).toMatchObject({ balanceCents: 1_000_000, allocatedCents: 750_000, unassignedCents: 250_000 });
    expect(acct.buckets.map((b: { name: string }) => b.name)).toEqual(["Emergency", "Vacation"]);
    expect(body.accounts.some((a: { accountId: string }) => a.accountId === card)).toBe(false);
  });

  it("refuses buckets on debts", async () => {
    expect((await api("POST", "/buckets", { accountId: card, name: "Nope" })).status).toBe(400);
  });

  it("moves money between buckets and from unassigned, within limits", async () => {
    expect((await api("POST", "/buckets/move", { fromBucketId: emergency, toBucketId: vacation, amountCents: 100_000 })).status).toBe(200);
    expect((await api("POST", "/buckets/move", { fromBucketId: null, toBucketId: vacation, amountCents: 250_000 })).status).toBe(200);
    const over = await api("POST", "/buckets/move", { fromBucketId: null, toBucketId: emergency, amountCents: 1 });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/unassigned/);
    const tooMuch = await api("POST", "/buckets/move", { fromBucketId: vacation, toBucketId: emergency, amountCents: 999_999_99 });
    expect(tooMuch.status).toBe(400);
    const acct = (await api("GET", "/buckets")).body.accounts.find((a: { accountId: string }) => a.accountId === savings);
    expect(acct.buckets.map((b: { allocatedCents: number }) => b.allocatedCents)).toEqual([500_000, 500_000]);
    expect(acct.unassignedCents).toBe(0);
  });

  it("a goal behind a bucket shows the bucket as its progress", async () => {
    const goal = (await api("POST", "/goals", { name: "Trip to Japan", targetCents: 800_000, color: "#6f8ef2" })).body;
    expect((await api("PATCH", `/buckets/${vacation}`, { goalId: goal.id })).status).toBe(200);
    const g = (await api("GET", "/goals")).body.goals.find((x: { id: string }) => x.id === goal.id);
    expect(g.savedCents).toBe(500_000);
    // One bucket per goal.
    expect((await api("PATCH", `/buckets/${emergency}`, { goalId: goal.id })).status).toBe(400);
  });

  it("shows over-allocation when the balance drops, and deletes cleanly", async () => {
    await api("PATCH", `/accounts/${savings}`, { balanceCents: 900_000 });
    const acct = (await api("GET", "/buckets")).body.accounts.find((a: { accountId: string }) => a.accountId === savings);
    expect(acct.unassignedCents).toBe(-100_000);
    expect((await api("DELETE", `/buckets/${emergency}`)).status).toBe(204);
  });
});
