import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { resolveTls } from "./tls.js";

const config = loadConfig();
const tls = resolveTls(config);

const app = await buildApp({
  config,
  ...(tls ? { https: tls } : {}),
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Vault Finance server listening on ${tls ? "https" : "http"}://${config.host}:${config.port}`,
  );
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
