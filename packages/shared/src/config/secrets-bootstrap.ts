/**
 * First-start secret bootstrap (self-host).
 *
 * In `self-host` mode a fresh install must run with zero manual `.env` editing.
 * Critical secrets that would otherwise be required (and abort startup when
 * missing) are generated once, persisted to a writable file next to the
 * database, and reused on every subsequent start.
 *
 * In `saas` mode nothing is generated — missing secrets remain a hard error,
 * preserving the strict hosted behavior.
 *
 * Persistence lives in `<dirname(DB_PATH)>/.secrets.env` (the data dir is a
 * durable bind-mount), NOT in `.env` (which is baked into the image at build
 * time and read-only at runtime).
 *
 * This module is deliberately dependency-light (only node builtins + dotenv)
 * and reads `process.env` directly so it can run BEFORE the config singleton
 * initializes — both from the standalone bootstrap script and from
 * `env.ts loadEnv()`.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/** Secrets auto-generated on first start in self-host mode. */
export interface GeneratedSecret {
  key: string;
  /** Whether this secret was newly generated in this run (vs already present). */
  generated: boolean;
  /** Present only for ADMIN_PASSWORD so the caller can surface it once. */
  value?: string;
}

const DB_PATH_DEFAULT = "./data/moira.db";
const SECRETS_FILE_NAME = ".secrets.env";

/** Resolve the durable secrets file path, alongside the SQLite database. */
export function getSecretsFilePath(): string {
  const dbPath = path.resolve(process.env.DB_PATH || DB_PATH_DEFAULT);
  return path.join(path.dirname(dbPath), SECRETS_FILE_NAME);
}

/**
 * Load persisted secrets into `process.env` WITHOUT overriding values already
 * set (explicit env / `.env` always wins over generated ones).
 * No-op if the file does not exist.
 */
export function loadPersistedSecrets(filePath: string = getSecretsFilePath()): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const parsed = dotenv.parse(fs.readFileSync(filePath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

function isSelfHost(): boolean {
  const raw = (process.env.DEPLOYMENT_MODE ?? "self-host").trim().toLowerCase();
  // Default self-host; only an explicit "saas" opts out. Invalid values are
  // validated/throw later in the config singleton — here we fail safe to
  // self-host so a fresh install can still boot.
  return raw !== "saas";
}

/** A 256-bit hex secret (matches the project idiom for keys/encryption). */
function generateHexSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** A human-typable but strong admin password. */
function generateAdminPassword(): string {
  // URL-safe base64 of 18 bytes → 24 chars, no padding/ambiguity issues.
  return crypto.randomBytes(18).toString("base64url");
}

/** Append/merge generated secrets into the persisted file (creates dir if needed). */
function persistSecrets(filePath: string, secrets: Record<string, string>): void {
  if (Object.keys(secrets).length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Preserve any existing content, then append the newly generated keys.
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8").trimEnd() : "";
  const header = existing
    ? ""
    : "# Auto-generated secrets (self-host first start). Do not commit. Do not edit.\n";
  const lines = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);
  const body = (existing ? existing + "\n" : "") + lines.join("\n") + "\n";
  fs.writeFileSync(filePath, header + body, { mode: 0o600 });
}

/**
 * Generate and persist missing critical secrets in self-host mode.
 *
 * Idempotent: secrets already present (in env, `.env`, or the persisted file)
 * are reused, not regenerated. In saas mode this is a no-op.
 *
 * Returns the per-secret outcome so the caller (bootstrap script) can log the
 * generated ADMIN_PASSWORD exactly once.
 */
export function bootstrapSelfHostSecrets(
  filePath: string = getSecretsFilePath(),
): GeneratedSecret[] {
  // Pull in anything already persisted so we don't regenerate across restarts.
  loadPersistedSecrets(filePath);

  if (!isSelfHost()) {
    return [];
  }

  const results: GeneratedSecret[] = [];
  const toPersist: Record<string, string> = {};

  const ensure = (key: string, gen: () => string, exposeValue = false): void => {
    const current = process.env[key];
    if (current !== undefined && current !== "") {
      results.push({ key, generated: false });
      return;
    }
    const value = gen();
    process.env[key] = value;
    toPersist[key] = value;
    results.push({ key, generated: true, value: exposeValue ? value : undefined });
  };

  ensure("BETTER_AUTH_SECRET", generateHexSecret);
  ensure("TELEGRAM_ENCRYPTION_KEY", generateHexSecret);
  ensure("ADMIN_PASSWORD", generateAdminPassword, /* exposeValue */ true);

  persistSecrets(filePath, toPersist);

  return results;
}
