import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { certFingerprint, resolveTls } from "./tls.js";

const config = loadConfig();
const tls = resolveTls(config);

const app = await buildApp({
  config,
  ...(tls ? { https: tls } : {}),
});

// The guided installer generates a random database password, but running
// `docker compose up` directly falls back to the vault/vault default. Postgres
// isn't published to the host, so this isn't remotely exploitable — it still
// means anything that reaches the Docker network owns the data.
if (/:\/\/vault:vault@/.test(config.databaseUrl)) {
  app.log.warn(
    "Postgres is using the default vault/vault credentials. Set POSTGRES_PASSWORD " +
      "in docker/.env (or run installers/server/install-server.sh) and recreate the " +
      "postgres volume to change it.",
  );
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Vault Finance server listening on ${tls ? "https" : "http"}://${config.host}:${config.port}`,
  );
  if (tls) {
    // The desktop trust screen tells users to find this exact line.
    app.log.info(`TLS certificate fingerprint (SHA-256): ${certFingerprint(tls.cert)}`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}
