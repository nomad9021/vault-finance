import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildControlApp, loadControlConfig } from "../src/app.js";

describe("control-plane app", () => {
  let app: FastifyInstance;
  let manifest: Server;
  const TOKEN = "x".repeat(40);

  beforeAll(async () => {
    manifest = createServer((_r, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tag_name: "v9.9.9" }));
    });
    await new Promise<void>((r) => manifest.listen(0, "127.0.0.1", r));
    const addr = manifest.address();
    const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}/latest` : "";

    app = await buildControlApp(
      loadControlConfig({
        CONTROL_ADMIN_TOKEN: TOKEN,
        UPDATE_MANIFEST_URL: url,
        LOG_LEVEL: "error",
      } as NodeJS.ProcessEnv),
    );
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => manifest.close(() => r()));
  });

  it("refuses to load without an admin token", () => {
    expect(() => loadControlConfig({} as NodeJS.ProcessEnv)).toThrow(/CONTROL_ADMIN_TOKEN/);
  });

  it("health needs no auth", async () => {
    const res = await app.inject({ method: "GET", url: "/control/health" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a bad bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/control/families" });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({
      method: "GET",
      url: "/control/families",
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("lists families (empty without docker) with the latest release version", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/control/families",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.families)).toBe(true);
    expect(body.latestVersion).toBe("9.9.9");
  });

  it("validates the create body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/control/families",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { slug: "BAD SLUG" },
    });
    expect(res.statusCode).toBe(400);
  });
});
