import { afterEach, describe, expect, test } from "@jest/globals";

const originalAppBasePath = process.env.APP_BASE_PATH;

async function importAuthConfig() {
  return import("../../../packages/shared/src/auth/better-auth-config.js");
}

describe("OAuth plugin page configuration follows the deployment base-path prefix", () => {
  afterEach(() => {
    if (originalAppBasePath === undefined) {
      delete process.env.APP_BASE_PATH;
    } else {
      process.env.APP_BASE_PATH = originalAppBasePath;
    }
  });

  test("plugin is configured with prefixed pages when the Web UI is served under a prefix", async () => {
    process.env.APP_BASE_PATH = "/app";
    const { buildMcpPluginOptions } = await importAuthConfig();

    expect(buildMcpPluginOptions()).toMatchObject({
      loginPage: "/app/oauth/authorize",
      oidcConfig: {
        loginPage: "/app/oauth/authorize",
        consentPage: "/app/oauth/consent",
      },
    });
  });

  test("plugin is configured with root pages when the Web UI is served at the root", async () => {
    process.env.APP_BASE_PATH = "/";
    const { buildMcpPluginOptions } = await importAuthConfig();

    expect(buildMcpPluginOptions()).toMatchObject({
      loginPage: "/oauth/authorize",
      oidcConfig: {
        loginPage: "/oauth/authorize",
        consentPage: "/oauth/consent",
      },
    });
  });
});
