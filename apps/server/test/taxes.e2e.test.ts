import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/config.js";

/** Salary & taxes: the household tax profile, its estimate, what-ifs, and the planner link. */

const PG_PORT = 55520;
let pg: EmbeddedPostgres;
let app: FastifyInstance;
let dataDir: string;
let pgDir: string;
let auth: { authorization: string };

const api = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload ? { payload: payload as object } : {}) });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "vault-tax-data-"));
  pgDir = mkdtempSync(path.join(tmpdir(), "vault-tax-pg-"));
  pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "vault", password: "vault", port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("vault");
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: `postgres://vault:vault@localhost:${PG_PORT}/vault`,
      VAULT_TLS: "off",
      VAULT_DATA_DIR: dataDir,
      LOG_LEVEL: "error",
    } as NodeJS.ProcessEnv),
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { ownerEmail: "riley@lakeside.home", ownerPassword: "correct-horse-battery", ownerDisplayName: "Riley" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "riley@lakeside.home", password: "correct-horse-battery", deviceName: "T", platform: "linux" },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(pgDir, { recursive: true, force: true });
});

const profile = {
  filingStatus: "single",
  state: "co",
  dependents: 0,
  earners: [{ name: "Riley", grossAnnualCents: 10_000_000, payFrequency: "biweekly" }],
  syncPlannedIncome: true,
};

describe("salary & taxes", () => {
  it("has no profile until one is saved", async () => {
    expect((await api("GET", "/tax-profile")).json()).toMatchObject({ year: 2026, profile: null, estimate: null });
  });

  it("saves a profile, estimates take-home and sets the planner's income", async () => {
    const res = await api("PUT", "/tax-profile", profile);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.state).toBe("CO");
    expect(body.estimate.takeHomeCents).toBe(7_548_840);
    const plan = (await api("GET", "/budget-plan")).json();
    expect(plan.plannedIncomeCents).toBe(Math.round(7_548_840 / 12));
  });

  it("leaves the planner alone when sync is off", async () => {
    await api("PUT", "/tax-profile", { ...profile, syncPlannedIncome: false, earners: [{ ...profile.earners[0], grossAnnualCents: 5_000_000 }] });
    expect((await api("GET", "/budget-plan")).json().plannedIncomeCents).toBe(Math.round(7_548_840 / 12));
  });

  it("runs what-ifs without saving, and explains bad places", async () => {
    const tx = await api("POST", "/tax/estimate", { ...profile, state: "TX" });
    expect(tx.statusCode).toBe(200);
    expect(tx.json().takeHomeCents).toBe(7_548_840 + 369_160);
    const bad = await api("POST", "/tax/estimate", { ...profile, state: "TX", locality: "nyc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/in NY/);
    expect((await api("GET", "/tax-profile")).json().profile.earners[0].grossAnnualCents).toBe(5_000_000);
  });

  it("lists every state and the known localities", async () => {
    const places = (await api("GET", "/tax/places")).json();
    expect(places.states).toHaveLength(51);
    expect(places.states.find((s: { code: string }) => s.code === "WA").taxesWages).toBe(false);
    expect(places.localities.filter((l: { state: string }) => l.state === "MD")).toHaveLength(24);
  });
});
