import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import fp from "fastify-plugin";
import postgres from "postgres";
import * as schema from "../db/schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    sql: postgres.Sql;
  }
}

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

export default fp(
  async (app, opts: { databaseUrl: string; runMigrations?: boolean }) => {
    const sql = postgres(opts.databaseUrl, {
      max: 10,
      onnotice: () => {}, // silence NOTICE chatter in logs
    });
    const db = drizzle(sql, { schema });

    if (opts.runMigrations !== false) {
      app.log.info("running database migrations");
      await migrate(db, { migrationsFolder });
      app.log.info("database migrations complete");
    }

    app.decorate("db", db);
    app.decorate("sql", sql);
    app.addHook("onClose", async () => {
      await sql.end();
    });
  },
  { name: "db" },
);
