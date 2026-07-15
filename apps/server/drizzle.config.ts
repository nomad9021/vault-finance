import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  // Only used by drizzle-kit CLI (generate/studio); the server itself reads
  // config through src/config.ts.
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://vault:vault@localhost:5432/vault",
  },
});
