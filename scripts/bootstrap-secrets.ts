#!/usr/bin/env node
/**
 * First-start secret bootstrap (self-host).
 *
 * Runs BEFORE migrations and before any service starts. In self-host mode it
 * generates the critical secrets that would otherwise abort startup
 * (BETTER_AUTH_SECRET, TELEGRAM_ENCRYPTION_KEY, ADMIN_PASSWORD) when missing,
 * persists them to `<dirname(DB_PATH)>/.secrets.env`, and shows the generated
 * ADMIN_PASSWORD in the logs exactly once.
 *
 * Idempotent: on subsequent starts the persisted secrets are reused.
 * In saas mode this is a no-op (missing secrets stay a hard error downstream).
 *
 * Loads `.env` first so operator-provided values always win over generation.
 */

import "dotenv/config";
// Import the dependency-light module DIRECTLY (not via the @mcp-moira/shared
// barrel): the barrel eagerly initializes auth/config, which would read—and on
// a fresh self-host install, fail on—the very secrets this script generates.
import {
  bootstrapSelfHostSecrets,
  getSecretsFilePath,
} from "../packages/shared/src/config/secrets-bootstrap.js";

const mode = (process.env.DEPLOYMENT_MODE ?? "self-host").trim().toLowerCase();
const results = bootstrapSelfHostSecrets();

if (mode === "saas") {
  console.log("DEPLOYMENT_MODE=saas — skipping secret auto-generation.");
  process.exit(0);
}

const generated = results.filter((r) => r.generated);

if (generated.length === 0) {
  console.log("All self-host secrets already present — nothing generated.");
  process.exit(0);
}

console.log("");
console.log("============================================================");
console.log("  Self-host first start: generated missing secrets");
console.log(`  Persisted to: ${getSecretsFilePath()}`);
console.log("============================================================");
for (const r of generated) {
  if (r.key === "ADMIN_PASSWORD" && r.value) {
    console.log("");
    console.log("  ADMIN LOGIN — record this now, it is shown only once:");
    console.log(`    email:    ${process.env.ADMIN_EMAIL || "admin@moira.local"}`);
    console.log(`    password: ${r.value}`);
    console.log("");
  } else {
    console.log(`  ${r.key}: generated (256-bit)`);
  }
}
console.log("============================================================");
console.log("");
