import { beforeAll, describe, expect, test } from "@jest/globals";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
let cookie = "";

beforeAll(async () => {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getAdminCredentials()),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).not.toBe("");
});

describe("GitHub codespace connection API with the default disabled configuration", () => {
  test("requires a Moira web session", async () => {
    const response = await fetch(`${baseUrl}/api/integrations/github`);
    expect(response.status).toBe(401);
  });

  test("reports a safe disabled state without provider or credential metadata", async () => {
    const response = await fetch(`${baseUrl}/api/integrations/github`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      state: "disabled",
      reason: "NOT_CONFIGURED",
      canConnect: false,
      canDisconnect: false,
    });
    expect(body.data.settingsUrl).toMatch(/\/settings#integrations-github$/);
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });

  test("refuses start and disconnect before contacting GitHub when configuration is absent", async () => {
    const start = await fetch(`${baseUrl}/api/integrations/github/start`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    // A browser navigation lands back on Settings with the reason, never on a JSON error.
    expect(start.status).toBe(303);
    const location = new URL(start.headers.get("location")!);
    expect(location.pathname).toMatch(/\/settings$/);
    expect(location.searchParams.get("github")).toBe("not_configured");
    expect(location.hash).toBe("#integrations-github");

    const disconnect = await fetch(`${baseUrl}/api/integrations/github`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(disconnect.status).toBe(503);
    await expect(disconnect.json()).resolves.toMatchObject({
      error: { code: "CODESPACE_NOT_CONFIGURED" },
    });
  });
});
