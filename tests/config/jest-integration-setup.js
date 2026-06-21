/**
 * Integration tests per-worker setup — runs in EACH worker.
 * Sets environment variables only. DB creation is in globalSetup.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "../..");

// Load .env.test for required environment variables (test-specific, separate from .env.local)
const envTestPath = path.join(projectRoot, ".env.test");
if (existsSync(envTestPath)) {
  const envContent = readFileSync(envTestPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        process.env[key] = valueParts.join("=");
      }
    }
  }
}

// ALWAYS use test-integration.db for integration tests (never production DB)
process.env.DB_PATH = "./data/test-integration.db";
