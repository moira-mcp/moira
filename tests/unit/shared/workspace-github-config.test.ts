import { describe, expect, test } from "@jest/globals";
import { evaluateWorkspaceGitHubConfig } from "@mcp-moira/shared";

const valid = {
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  baseUrl: "https://moira.example.com",
  appPrefix: "/app",
};

describe("GitHub workspace configuration", () => {
  test("keeps the feature disabled when no workspace secret is configured", () => {
    expect(
      evaluateWorkspaceGitHubConfig({ baseUrl: valid.baseUrl, appPrefix: valid.appPrefix }),
    ).toEqual({
      state: "disabled",
      reason: "NOT_CONFIGURED",
      settingsUrl: "https://moira.example.com/app/settings#integrations-github",
    });
  });

  test("accepts an exact same-origin callback and dedicated strong vault key", () => {
    expect(evaluateWorkspaceGitHubConfig(valid)).toEqual({
      state: "available",
      clientId: valid.clientId,
      clientSecret: valid.clientSecret,
      callbackUrl: valid.callbackUrl,
      installationUrl: valid.installationUrl,
      vaultKeyHex: valid.vaultKeyHex,
      vaultKeyVersion: "v1",
      settingsUrl: "https://moira.example.com/app/settings#integrations-github",
    });
  });

  test.each([
    [{ ...valid, clientSecret: undefined }, "INCOMPLETE_CONFIGURATION"],
    [{ ...valid, clientId: "invalid client id" }, "INVALID_CLIENT_ID"],
    [
      { ...valid, callbackUrl: "https://evil.example/api/integrations/github/callback" },
      "CALLBACK_ORIGIN_MISMATCH",
    ],
    [
      { ...valid, callbackUrl: "http://moira.example.com/api/integrations/github/callback" },
      "INVALID_CALLBACK_URL",
    ],
    [
      {
        ...valid,
        callbackUrl: "https://moira.example.com/api/integrations/github/callback?next=evil",
      },
      "INVALID_CALLBACK_URL",
    ],
    [
      { ...valid, installationUrl: "https://evil.example/apps/moira/installations/new" },
      "INVALID_INSTALL_URL",
    ],
    [{ ...valid, clientSecret: "a".repeat(40) }, "INVALID_CLIENT_SECRET"],
    [{ ...valid, clientSecret: "change-me-client-secret-value" }, "INVALID_CLIENT_SECRET"],
    [{ ...valid, vaultKeyHex: "a".repeat(64) }, "INVALID_VAULT_KEY"],
    [{ ...valid, vaultKeyVersion: "../../v2" }, "INVALID_KEY_VERSION"],
  ])("fails closed for an invalid partial or security-sensitive value", (input, reason) => {
    expect(evaluateWorkspaceGitHubConfig(input)).toMatchObject({ state: "invalid", reason });
  });
});
