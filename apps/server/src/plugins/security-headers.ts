import fp from "fastify-plugin";

/**
 * Baseline security headers on every response (OWASP "Secure Headers").
 * Dependency-free to match the rest of the server; the mobile HTML route sets
 * its own stricter CSP, which — being route-level — takes precedence there.
 *
 * The API serves JSON to native (Tauri) and phone-web clients, so the default
 * CSP is deliberately locked down: nothing here should ever load subresources.
 */
export default fp(
  async (app, opts: { tls: boolean }) => {
    app.addHook("onSend", async (_request, reply, payload) => {
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "no-referrer");
      reply.header("cross-origin-opener-policy", "same-origin");
      reply.header("cross-origin-resource-policy", "same-origin");
      reply.header(
        "permissions-policy",
        "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
      );
      // Default-deny CSP for API responses. Routes that serve HTML (the mobile
      // viewer) override this with their own header.
      if (!reply.getHeader("content-security-policy")) {
        reply.header(
          "content-security-policy",
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        );
      }
      // HSTS only over TLS — pointless (and ignored) on plain HTTP, and we
      // don't want to pin it during http dev/tests.
      if (opts.tls) {
        reply.header(
          "strict-transport-security",
          "max-age=31536000; includeSubDomains",
        );
      }
      return payload;
    });
  },
  { name: "security-headers" },
);
