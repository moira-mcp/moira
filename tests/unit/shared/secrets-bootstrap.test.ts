import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import {
  bootstrapSelfHostSecrets,
  loadPersistedSecrets,
  getSecretsFilePath,
} from "@mcp-moira/shared";

const SECRET_KEYS = ["BETTER_AUTH_SECRET", "TELEGRAM_ENCRYPTION_KEY", "ADMIN_PASSWORD"] as const;

const savedEnv: Record<string, string | undefined> = {};
let tmpDir: string;
let secretsFile: string;

function snapshotEnv(): void {
  for (const k of [...SECRET_KEYS, "DEPLOYMENT_MODE", "DB_PATH"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("secrets-bootstrap", () => {
  beforeEach(() => {
    snapshotEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-secrets-"));
    // Point DB_PATH into the temp dir so the secrets file resolves there.
    process.env.DB_PATH = path.join(tmpDir, "moira.db");
    secretsFile = path.join(tmpDir, ".secrets.env");
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getSecretsFilePath", () => {
    it("resolves alongside the database file", () => {
      expect(getSecretsFilePath()).toBe(secretsFile);
    });
  });

  describe("self-host generation", () => {
    it("generates all missing secrets and persists them", () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const results = bootstrapSelfHostSecrets();

      for (const key of SECRET_KEYS) {
        const r = results.find((x) => x.key === key);
        expect(r?.generated).toBe(true);
        expect(process.env[key]).toBeTruthy();
      }
      // Crypto secrets are 64 hex chars (256-bit).
      expect(process.env.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
      expect(process.env.TELEGRAM_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(secretsFile)).toBe(true);
    });

    it("exposes the generated ADMIN_PASSWORD value once, masks crypto secrets", () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const results = bootstrapSelfHostSecrets();

      const admin = results.find((r) => r.key === "ADMIN_PASSWORD");
      expect(admin?.value).toBeTruthy();
      expect(admin?.value).toBe(process.env.ADMIN_PASSWORD);

      const authSecret = results.find((r) => r.key === "BETTER_AUTH_SECRET");
      expect(authSecret?.value).toBeUndefined();
    });

    it("does not regenerate a secret already present in env", () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      process.env.BETTER_AUTH_SECRET = "operator-provided-secret";
      const results = bootstrapSelfHostSecrets();

      const r = results.find((x) => x.key === "BETTER_AUTH_SECRET");
      expect(r?.generated).toBe(false);
      expect(process.env.BETTER_AUTH_SECRET).toBe("operator-provided-secret");
    });
  });

  describe("idempotency across restarts", () => {
    it("reuses persisted secrets instead of generating new ones", () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      bootstrapSelfHostSecrets();
      const first = { ...process.env };

      // Simulate a restart: clear the in-process env, keep the persisted file.
      for (const key of SECRET_KEYS) delete process.env[key];

      const results = bootstrapSelfHostSecrets();
      for (const key of SECRET_KEYS) {
        expect(results.find((x) => x.key === key)?.generated).toBe(false);
        expect(process.env[key]).toBe(first[key]);
      }
    });
  });

  describe("saas mode", () => {
    it("generates nothing and writes no file", () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const results = bootstrapSelfHostSecrets();

      expect(results).toEqual([]);
      for (const key of SECRET_KEYS) {
        expect(process.env[key]).toBeUndefined();
      }
      expect(fs.existsSync(secretsFile)).toBe(false);
    });
  });

  describe("loadPersistedSecrets", () => {
    it("loads persisted values without overriding existing env", () => {
      fs.writeFileSync(secretsFile, "BETTER_AUTH_SECRET=from-file\nADMIN_PASSWORD=file-pw\n");
      process.env.BETTER_AUTH_SECRET = "already-set";

      loadPersistedSecrets();

      // Existing value wins; absent value is filled from the file.
      expect(process.env.BETTER_AUTH_SECRET).toBe("already-set");
      expect(process.env.ADMIN_PASSWORD).toBe("file-pw");
    });

    it("is a no-op when the file is absent", () => {
      expect(() => loadPersistedSecrets()).not.toThrow();
      expect(process.env.BETTER_AUTH_SECRET).toBeUndefined();
    });
  });
});
