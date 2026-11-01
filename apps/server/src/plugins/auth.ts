import { AccessTokenClaims } from "@vault/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { SignJWT, jwtVerify } from "jose";
import { forbidden, sessionRevoked, tokenExpired, tokenInvalid } from "../errors.js";

export interface AuthContext {
  userId: string;
  deviceSessionId: string;
  role: "owner" | "member";
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken(claims: AccessTokenClaims): Promise<string>;
    /** preHandler: rejects unauthenticated requests and populates request.auth. */
    requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** preHandler: requireAuth + owner role. */
    requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export default fp(
  async (app, opts: { jwtSecret: string; accessTokenTtlSeconds: number }) => {
    const key = new TextEncoder().encode(opts.jwtSecret);

    app.decorateRequest("auth", null);

    app.decorate("signAccessToken", async (claims: AccessTokenClaims) => {
      return new SignJWT({ role: claims.role })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.sub)
        .setJti(claims.sid) // device session id rides in jti
        .setIssuedAt()
        .setExpirationTime(`${opts.accessTokenTtlSeconds}s`)
        .sign(key);
    });

    app.decorate("requireAuth", async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw tokenInvalid();

      let payload;
      try {
        ({ payload } = await jwtVerify(header.slice("Bearer ".length), key, {
          algorithms: ["HS256"],
        }));
      } catch (err) {
        if (err instanceof Error && err.name === "JWTExpired") throw tokenExpired();
        throw tokenInvalid();
      }

      const parsed = AccessTokenClaims.safeParse({
        sub: payload.sub,
        sid: payload.jti,
        role: payload["role"],
      });
      if (!parsed.success) throw tokenInvalid();

      // A valid signature isn't enough: the session behind the token must
      // still be live, so signing out, revoking a device or removing a member
      // takes effect at once rather than when the token expires. The role
      // comes from the database too, never from the (possibly stale) token.
      const [live] = await app.sql<{ role: "owner" | "member" }[]>`
        SELECT u.role
        FROM device_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ${parsed.data.sid} AND s.user_id = ${parsed.data.sub} AND s.revoked_at IS NULL
      `;
      if (!live) throw sessionRevoked();

      request.auth = {
        userId: parsed.data.sub,
        deviceSessionId: parsed.data.sid,
        role: live.role,
      };
    });

    app.decorate(
      "requireOwner",
      async (request: FastifyRequest, reply: FastifyReply) => {
        await app.requireAuth(request, reply);
        if (request.auth?.role !== "owner") {
          throw forbidden("Only the owner can do that.");
        }
      },
    );
  },
  { name: "auth" },
);
