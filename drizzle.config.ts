import { defineConfig } from "drizzle-kit";

const connectionString =
  process.env.DRIZZLE_DATABASE_URL_DEV || process.env.DATABASE_URL || "";

if (!connectionString) {
  throw new Error("Missing DRIZZLE_DATABASE_URL_DEV or DATABASE_URL");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: connectionString },
});
