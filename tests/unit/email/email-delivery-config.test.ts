import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateEmailStartupRequirement,
  closeDatabase,
  getEmailDeliveryStatus,
  getDeploymentMode,
  getSqliteInstance,
  getSmtpConfig,
} from "@mcp-moira/shared";
import {
  isEmailConfigured,
  getEmailProvider,
  sendEmail,
  shouldSuppressTestRecipient,
} from "@mcp-moira/shared/email/index.js";
import { BrevoProvider } from "../../../packages/shared/src/email/brevo-provider.js";
import { SmtpProvider } from "../../../packages/shared/src/email/smtp-provider.js";

const KEYS = [
  "DEPLOYMENT_MODE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "BREVO_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_REQUIRE_TLS",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_TEST_RECIPIENTS",
  "DB_PATH",
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalExitCode = process.exitCode;

function runStartupValidation(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    ENV_FILE_FOLDER: join(tmpdir(), "moira-email-config-validation-empty"),
    MOIRA_HOST: "localhost",
    BETTER_AUTH_SECRET: "unit-email-validation-secret-32-characters",
    TELEGRAM_ENCRYPTION_KEY: "4f4bb7f3cb7e4efead8b0e6d6d42f33b993207a1b5e24e5ebbb74f1ebfa76b2d",
    DB_PATH: ":memory:",
  };
  delete env.JEST_WORKER_ID;
  delete env.TEST_ENV;
  for (const key of KEYS) delete env[key];
  Object.assign(env, overrides);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  return spawnSync(
    `${process.cwd()}/node_modules/.bin/tsx`,
    [
      "--eval",
      `import { validateEnvConfig } from "./packages/shared/src/config/env.ts";
       try {
         validateEnvConfig();
         process.stdout.write("VALIDATION_OK");
         process.exit(0);
       } catch (error) {
         process.stderr.write(error instanceof Error ? error.message : String(error));
         process.stderr.write("\\nPRODUCT_EXIT_CODE=" + String(process.exitCode));
         process.exit(process.exitCode ?? 0);
       }`,
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
}

function clearEmailEnvironment(): void {
  for (const key of KEYS) delete process.env[key];
}

describe("email delivery configuration", () => {
  beforeAll(() => {
    getDeploymentMode();
  });

  beforeEach(clearEmailEnvironment);

  afterAll(() => {
    clearEmailEnvironment();
    for (const key of KEYS) {
      if (original[key] !== undefined) process.env[key] = original[key];
    }
    process.exitCode = originalExitCode;
  });

  it("reports an unconfigured install as unavailable rather than test delivery", () => {
    expect(getEmailDeliveryStatus()).toEqual({
      state: "unavailable",
      provider: null,
      available: false,
      reason: "No email provider is configured",
    });
    expect(() => getEmailProvider()).toThrow("No email provider is configured");
  });

  it("reports an unknown selected provider as a configuration error", () => {
    process.env.EMAIL_PROVIDER = "unknown-provider";
    expect(getEmailDeliveryStatus()).toEqual({
      state: "configuration-error",
      provider: null,
      available: false,
      reason:
        'Invalid EMAIL_PROVIDER "unknown-provider". Allowed values: smtp, brevo, test, none, auto',
    });
  });

  it("reports the explicit test sink without claiming real delivery", () => {
    process.env.EMAIL_PROVIDER = "test";
    expect(getEmailDeliveryStatus()).toMatchObject({
      state: "test",
      provider: "test",
      available: false,
    });
    expect(isEmailConfigured()).toBe(false);
  });

  it("accepts SMTP without authentication and defaults to port 587", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.SMTP_HOST = "mail.internal";
    process.env.EMAIL_FROM = "moira@example.test";
    expect(getEmailDeliveryStatus()).toEqual({
      state: "real",
      provider: "smtp",
      available: true,
      reason: null,
    });
    expect(isEmailConfigured()).toBe(true);
    expect(getEmailProvider()).toBeInstanceOf(SmtpProvider);
  });

  it("rejects partial SMTP authentication", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.SMTP_HOST = "mail.internal";
    process.env.EMAIL_FROM = "moira@example.test";
    process.env.SMTP_USER = "moira";
    expect(getEmailDeliveryStatus()).toMatchObject({
      state: "configuration-error",
      provider: "smtp",
      available: false,
    });
    expect(getEmailDeliveryStatus().reason).toContain("SMTP_PASSWORD");
  });

  it("rejects SMTP when either the host or sender is missing", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = "moira@example.test";
    expect(getEmailDeliveryStatus()).toMatchObject({
      state: "configuration-error",
      provider: "smtp",
      available: false,
    });
    expect(getEmailDeliveryStatus().reason).toContain("SMTP_HOST");

    delete process.env.EMAIL_FROM;
    process.env.SMTP_HOST = "mail.internal";
    expect(getEmailDeliveryStatus().reason).toContain("EMAIL_FROM");
  });

  it("rejects invalid SMTP ports and TLS booleans", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.SMTP_HOST = "mail.internal";
    process.env.EMAIL_FROM = "moira@example.test";
    process.env.SMTP_PORT = "70000";
    process.env.SMTP_SECURE = "yes";
    expect(getEmailDeliveryStatus().reason).toContain("valid SMTP_PORT");
    expect(getEmailDeliveryStatus().reason).toContain("SMTP_SECURE=true or false");
  });

  it("maps authenticated implicit TLS and required STARTTLS without exposing credentials in status", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.SMTP_HOST = "mail.internal";
    process.env.EMAIL_FROM = "moira@example.test";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_REQUIRE_TLS = "true";
    process.env.SMTP_USER = "moira-user";
    process.env.SMTP_PASSWORD = "smtp-secret";
    expect(getSmtpConfig()).toEqual({
      host: "mail.internal",
      port: 465,
      secure: true,
      requireTls: true,
      user: "moira-user",
      password: "smtp-secret",
    });
    expect(JSON.stringify(getEmailDeliveryStatus())).not.toContain("smtp-secret");
  });

  it("accepts Brevo only with both API key and sender", () => {
    process.env.EMAIL_PROVIDER = "brevo";
    process.env.BREVO_API_KEY = "secret-not-logged";
    expect(getEmailDeliveryStatus()).toMatchObject({ state: "configuration-error" });
    process.env.EMAIL_FROM = "moira@example.test";
    expect(getEmailDeliveryStatus()).toEqual({
      state: "real",
      provider: "brevo",
      available: true,
      reason: null,
    });
  });

  it("honors explicit provider selection over unrelated provider variables", () => {
    process.env.EMAIL_PROVIDER = "brevo";
    process.env.BREVO_API_KEY = "secret-not-logged";
    process.env.EMAIL_FROM = "moira@example.test";
    process.env.SMTP_USER = "incomplete-but-unselected";
    expect(getEmailDeliveryStatus()).toMatchObject({ state: "real", provider: "brevo" });
  });

  it("preserves legacy Brevo-only automatic selection", () => {
    process.env.BREVO_API_KEY = "legacy-secret-not-logged";
    process.env.EMAIL_FROM = "moira@example.test";

    expect(getEmailDeliveryStatus()).toEqual({
      state: "real",
      provider: "brevo",
      available: true,
      reason: null,
    });
  });

  it.each([
    ["default SMTP tuning", { SMTP_PORT: "587", SMTP_SECURE: "false" }],
    ["partial SMTP authentication", { SMTP_USER: "incomplete-smtp-user" }],
    ["invalid partial SMTP transport", { SMTP_HOST: "mail.internal", SMTP_PORT: "70000" }],
  ])("keeps valid legacy Brevo when auto mode also sees %s", (_name, smtpVariables) => {
    process.env.EMAIL_PROVIDER = "auto";
    process.env.BREVO_API_KEY = "legacy-secret-not-logged";
    process.env.EMAIL_FROM = "moira@example.test";
    Object.assign(process.env, smtpVariables);

    expect(getEmailDeliveryStatus()).toEqual({
      state: "real",
      provider: "brevo",
      available: true,
      reason: null,
    });
  });

  it("prefers complete SMTP configuration over Brevo in automatic mode", () => {
    process.env.EMAIL_PROVIDER = "auto";
    process.env.BREVO_API_KEY = "unused-brevo-secret";
    process.env.EMAIL_FROM = "moira@example.test";
    process.env.SMTP_HOST = "mail.internal";

    expect(getEmailDeliveryStatus()).toEqual({
      state: "real",
      provider: "smtp",
      available: true,
      reason: null,
    });
  });

  it("suppresses the CI mail-producing recipient domains only behind the explicit switch", async () => {
    closeDatabase();
    process.env.DB_PATH = ":memory:";
    process.env.EMAIL_PROVIDER = "brevo";
    process.env.BREVO_API_KEY = "secret-not-logged";
    process.env.EMAIL_FROM = "moira@example.test";
    expect(shouldSuppressTestRecipient("test123@example.com")).toBe(false);
    process.env.EMAIL_TEST_RECIPIENTS = "true";

    const recipients = [
      "signup@example.com",
      "forgot-password@test.com",
      "fixture@test.local",
      "e2e-user@moira.local",
      "loadtest@load-testing-noverify.local",
      "transport@reserved-domain.test",
    ];
    for (const recipient of recipients) {
      expect(shouldSuppressTestRecipient(recipient)).toBe(true);
    }
    expect(shouldSuppressTestRecipient("customer@real-domain.example")).toBe(false);
    expect(getEmailDeliveryStatus()).toMatchObject({ state: "real", available: true });

    const sqlite = getSqliteInstance();
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE emailLog (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        "to" TEXT NOT NULL,
        subject TEXT NOT NULL,
        messageId TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        createdAt TEXT NOT NULL
      );
      INSERT INTO user (id) VALUES ('ci-recipient-proof');
    `);

    const realDelivery = jest.spyOn(BrevoProvider.prototype, "send");
    try {
      for (const recipient of recipients) {
        await expect(
          sendEmail("ci-recipient-proof", "verification", {
            to: recipient,
            subject: "CI recipient suppression proof",
            text: "This message must remain local",
          }),
        ).resolves.toMatchObject({ provider: "test", delivery: "logged", success: true });
      }
      expect(realDelivery).not.toHaveBeenCalled();
      expect(
        sqlite
          .prepare(
            `SELECT "to" AS recipient, status
             FROM emailLog WHERE userId = ? ORDER BY recipient`,
          )
          .all("ci-recipient-proof"),
      ).toEqual(
        recipients
          .map((recipient) => ({ recipient, status: "logged" }))
          .sort((left, right) => left.recipient.localeCompare(right.recipient)),
      );
    } finally {
      realDelivery.mockRestore();
      closeDatabase();
    }
  });

  it("fails SaaS startup without real delivery but lets self-host continue", () => {
    const unavailable = {
      state: "unavailable" as const,
      provider: null,
      available: false,
      reason: "No email provider is configured",
    };
    expect(evaluateEmailStartupRequirement("saas", unavailable)).toContain(
      "requires a real SMTP or Brevo email provider",
    );
    expect(evaluateEmailStartupRequirement("self-host", unavailable)).toBeNull();
  });

  it("fails every deployment mode on an invalid selected provider configuration", () => {
    const invalid = {
      state: "configuration-error" as const,
      provider: "smtp" as const,
      available: false,
      reason: "SMTP requires SMTP_HOST",
    };
    expect(evaluateEmailStartupRequirement("self-host", invalid)).toBe(invalid.reason);
    expect(evaluateEmailStartupRequirement("saas", invalid)).toBe(invalid.reason);
  });

  it("lets actual self-host startup validation continue without a provider", () => {
    const result = runStartupValidation({
      DEPLOYMENT_MODE: "self-host",
      EMAIL_PROVIDER: "none",
    });

    expect(result.status).toBe(0);
  });

  it.each([
    {
      name: "SaaS without a provider",
      mode: "saas",
      provider: "none",
      from: undefined,
      expected: /requires a real SMTP or Brevo email provider/,
    },
    {
      name: "SaaS with the explicit test sink",
      mode: "saas",
      provider: "test",
      from: undefined,
      expected: /requires a real SMTP or Brevo email provider/,
    },
    {
      name: "self-host with an unknown provider",
      mode: "self-host",
      provider: "unknown-provider",
      from: undefined,
      expected: /Invalid EMAIL_PROVIDER "unknown-provider"/,
    },
    {
      name: "SaaS with an unknown provider",
      mode: "saas",
      provider: "unknown-provider",
      from: undefined,
      expected: /Invalid EMAIL_PROVIDER "unknown-provider"/,
    },
    {
      name: "self-host with partial SMTP configuration",
      mode: "self-host",
      provider: "smtp",
      from: "moira@example.test",
      expected: /SMTP_HOST/,
    },
    {
      name: "SaaS with partial SMTP configuration",
      mode: "saas",
      provider: "smtp",
      from: "moira@example.test",
      expected: /SMTP_HOST/,
    },
  ])("fails actual startup validation for $name", ({ mode, provider, from, expected }) => {
    const result = runStartupValidation({
      DEPLOYMENT_MODE: mode,
      EMAIL_PROVIDER: provider,
      EMAIL_FROM: from,
    });

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(expected);
    expect(output).toContain("PRODUCT_EXIT_CODE=1");
  });
});
