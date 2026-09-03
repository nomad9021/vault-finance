import { timingSafeEqual } from "node:crypto";
import {
  type ControlActionResponse,
  type ControlFamilyListResponse,
  CreateFamilyRequest,
  type CreateFamilyResponse,
  compareSemver,
} from "@vault/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { familyctl, familyVersion, listFamilies } from "./familyctl.js";
import { mailEnabled, sendWelcome } from "./mail.js";

export interface ControlConfig {
  adminToken: string;
  surveyUrl?: string | undefined;
  /** GitHub releases API (or a fixture in tests). */
  manifestUrl: string;
  logLevel: string;
}

export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const adminToken = env["CONTROL_ADMIN_TOKEN"] ?? "";
  if (adminToken.length < 16) {
    throw new Error("CONTROL_ADMIN_TOKEN must be set (>= 16 chars) — refusing to start");
  }
  return {
    adminToken,
    ...(env["SURVEY_URL"] ? { surveyUrl: env["SURVEY_URL"] } : {}),
    manifestUrl:
      env["UPDATE_MANIFEST_URL"] ??
      "https://api.github.com/repos/nomad9021/vault-finance/releases/latest",
    logLevel: env["LOG_LEVEL"] ?? "info",
  };
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function fetchLatestVersion(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "vault-finance-control" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string; name?: string };
    const tag = body.tag_name ?? body.name;
    const m = tag ? /(\d+\.\d+\.\d+)/.exec(tag) : null;
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Register the control-plane routes on an already-constructed Fastify instance. */
export function registerControlRoutes(app: FastifyInstance, config: ControlConfig): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", message: err.issues[0]?.message ?? "Invalid request." } });
    }
    app.log.error({ err }, "control request failed");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });

  app.get("/control/health", async () => ({ status: "ok", mailEnabled }));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/control/health") return;
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !tokensMatch(token, config.adminToken)) {
      return reply
        .status(401)
        .send({ error: { code: "TOKEN_INVALID", message: "Bad admin token." } });
    }
  });

  app.get("/control/families", async (): Promise<ControlFamilyListResponse> => {
    const [families, latestVersion] = await Promise.all([
      listFamilies(),
      fetchLatestVersion(config.manifestUrl),
    ]);
    await Promise.all(
      families.map(async (f) => {
        f.runningVersion = await familyVersion(f.slug);
      }),
    );
    return { families, latestVersion };
  });

  app.post("/control/families", async (request, reply) => {
    const body = CreateFamilyRequest.parse(request.body);
    if (body.mode === "proxy" && !body.domain) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", message: "proxy mode needs a domain" } });
    }
    const args = ["create", body.slug];
    if (body.port) args.push("--port", String(body.port));
    if (body.mode === "proxy") args.push("--proxy", "--domain", body.domain!);
    if (body.ownerEmail) args.push("--owner-email", body.ownerEmail);

    const result = await familyctl(args);
    if (!result.ok) {
      return reply
        .status(500)
        .send({ error: { code: "INTERNAL", message: result.log.slice(-2000) } });
    }

    const connect =
      /Connect address for this family:\s*(\S+)/.exec(result.log)?.[1] ??
      (body.mode === "proxy" ? `https://${body.domain}` : "");

    let welcomeEmailSent = false;
    if (body.ownerEmail && connect) {
      welcomeEmailSent = await sendWelcome({
        ownerEmail: body.ownerEmail,
        connectUrl: connect,
        surveyUrl: config.surveyUrl,
      });
    }

    const response: CreateFamilyResponse = {
      slug: body.slug,
      connectUrl: connect,
      welcomeEmailSent,
    };
    return reply.status(201).send(response);
  });

  app.post<{ Params: { slug: string } }>(
    "/control/families/:slug/update",
    async (request, reply): Promise<ControlActionResponse> => {
      const result = await familyctl(["update", request.params.slug]);
      if (!result.ok) reply.status(500);
      return result;
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/control/families/:slug",
    async (request, reply): Promise<ControlActionResponse | { error: unknown }> => {
      const { slug } = request.params;
      const confirm = (request.body as { confirm?: string } | undefined)?.confirm;
      if (confirm !== slug) {
        reply.status(400);
        return { error: { code: "VALIDATION_ERROR", message: `confirm must equal "${slug}"` } };
      }
      const result = await familyctl(["destroy", slug]);
      if (!result.ok) reply.status(500);
      return result;
    },
  );

  app.get("/control/updates", async () => {
    const [families, latestVersion] = await Promise.all([
      listFamilies(),
      fetchLatestVersion(config.manifestUrl),
    ]);
    const withVersions = await Promise.all(
      families.map(async (f) => {
        const running = await familyVersion(f.slug);
        return {
          slug: f.slug,
          runningVersion: running,
          updateAvailable:
            !!running && !!latestVersion && compareSemver(latestVersion, running) > 0,
        };
      }),
    );
    return { latestVersion, families: withVersions };
  });
}

/** Plain-HTTP app — used by tests and by `server.ts` when CONTROL_TLS=off. */
export async function buildControlApp(config: ControlConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: false });
  registerControlRoutes(app, config);
  return app;
}
