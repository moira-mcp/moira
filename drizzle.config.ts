import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/shared/src/database/schema.ts",
  out: "./packages/web-backend/drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DB_PATH || "./data/moira.db",
  },
});
