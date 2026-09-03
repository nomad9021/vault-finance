import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import selfsigned from "selfsigned";
import { loadControlConfig, registerControlRoutes } from "./app.js";

const config = loadControlConfig();
const port = Number(process.env["CONTROL_PORT"] ?? 9443);
const host = process.env["CONTROL_HOST"] ?? "0.0.0.0";
const dataDir = process.env["CONTROL_DATA_DIR"] ?? "/data";
const tlsOn = process.env["CONTROL_TLS"] !== "off";

function selfSignedTls(): { cert: string; key: string } {
  const certPath = path.join(dataDir, "control-cert.pem");
  const keyPath = path.join(dataDir, "control-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  }
  const pems = selfsigned.generate([{ name: "commonName", value: "vault-control" }], {
    days: 3650,
    keySize: 2048,
  });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

const tls = tlsOn ? selfSignedTls() : null;
const app = Fastify({
  logger: { level: config.logLevel },
  trustProxy: false,
  ...(tls ? { https: tls } : {}),
});
registerControlRoutes(app, config);

try {
  await app.listen({ port, host });
  app.log.info(`vault-control listening on ${tls ? "https" : "http"}://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
