/**
 * Integration tests global setup — runs ONCE before all workers.
 * Builds the shipped local companion assets and creates a fresh migrated test database.
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "../..");

// Load .env.test for required environment variables (test-specific, separate from .env.local)
const envTestPath = path.join(projectRoot, ".env.test");
const envVars = {};
if (existsSync(envTestPath)) {
  const envContent = readFileSync(envTestPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        envVars[key] = valueParts.join("=");
      }
    }
  }
}

const testDbPath = "./data/test-integration.db";
const dbDir = path.dirname(testDbPath);

export default async function globalSetup() {
  // Direct source consumers use the same fixed native helper as the packaged companion.
  execSync("npm run local:build", { cwd: projectRoot, stdio: "inherit" });

  // Ensure data directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Remove main DB file and WAL auxiliary files (-wal, -shm)
  if (existsSync(testDbPath)) {
    execSync(`rm -f ${testDbPath} ${testDbPath}-wal ${testDbPath}-shm`, { stdio: "inherit" });
  }

  console.log("Setting up integration test database:", testDbPath);
  execSync("tsx scripts/run-migrations.ts", {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envVars,
      DB_PATH: testDbPath,
      ADMIN_PASSWORD: envVars.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "AdminTest123",
    },
    stdio: "inherit",
  });
}
