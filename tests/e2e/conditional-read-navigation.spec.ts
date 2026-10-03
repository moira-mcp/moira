/**
 * A warm page revalidates its projection rather than reusing a stale client value.
 * The write happens through a separately initialized MCP client, so a browser-only
 * mutation invalidation cannot accidentally make the external-change case pass.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { callMCPTool, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

for (const kind of ["notes", "playbooks"] as const) {
  test(`${kind}: warm SPA navigation restores a 304 projection and sees an external MCP revision`, async ({
    page,
  }) => {
    const identity = randomUUID();
    const email = `conditional-${identity}@example.com`;
    const password = "TestPassword123!";
    const created = await createTestUser(email, password, "Conditional read user", true);
    expect(created.success, created.error).toBe(true);
    // connect() performs authenticated MCP initialize, accepting the current tool catalogue.
    const mcp = await createAuthenticatedMCPClient({ email, password });
    const key = `conditional-${identity}`;
    const original = "Original projection from MCP";
    const updated = "Changed outside the browser through MCP";
    const args = kind === "notes" ? { key } : { name: key };
    const save = (content: string) =>
      callMCPTool<Record<string, unknown>>(mcp.client, kind, {
        action: "save",
        ...args,
        ...(kind === "notes" ? { value: content } : { content }),
      });
    const endpoint = `/api/${kind}`;
    const isList = (url: string) => new URL(url).pathname === endpoint;

    try {
      expect(await save(original)).toMatchObject({ created: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      // Pass through to the real server. Route interception disables Chromium's native
      // HTTP cache, so the application must itself restore the retained body after 304.
      await page.route(/\/api\/(?:notes|playbooks)(\?|$)/, (route) => {
        const headers = route.request().headers();
        // Cache-disabled Chromium adds reload directives after interception, absent from
        // Playwright's provisional headers. Keep the app's validator/auth and native cache
        // disabled, but do not turn an ordinary conditional SPA read into a forced reload.
        return headers["if-none-match"]
          ? route.continue({ headers: { ...headers, "cache-control": "", pragma: "" } })
          : route.continue();
      });
      await login(page, email, password);
      const sidebar = page.locator('[data-slot="sidebar"]').first();
      await expect(sidebar).toBeVisible();
      const link = sidebar.locator(`a[href="/${kind}"]`);
      const card = page.getByTestId(kind === "notes" ? `note-row-${key}` : `playbook-card-${key}`);

      const firstRead = page.waitForResponse(
        (response) => isList(response.url()) && response.status() === 200,
      );
      await link.click();
      const first = await firstRead;
      expect(first.headers().etag).toBeTruthy();
      await expect(card).toContainText(original);
      await sidebar.locator('a[href="/"]').click();
      await expect(page.getByTestId("home-how-it-works")).toBeVisible();

      const validatedRead = page.waitForResponse(
        (response) =>
          isList(response.url()) && Boolean(response.request().headers()["if-none-match"]),
      );
      await link.click();
      const unchanged = await validatedRead;
      expect(unchanged.status()).toBe(304);
      const validator = unchanged.request().headers()["if-none-match"];
      expect(validator).toBeTruthy();
      expect(unchanged.headers().etag).toBe(validator);
      await expect(card).toContainText(original);
      await expect(sidebar).toBeVisible();

      await sidebar.locator('a[href="/"]').click();
      await expect(page.getByTestId("home-how-it-works")).toBeVisible();
      expect(await save(updated)).toMatchObject({ created: false });
      // Revalidate the exact representation that produced the previous 304. Pagination
      // may also read another bounded page size while measuring cards; those are separate keys.
      const changedRead = page.waitForResponse(
        (response) =>
          isList(response.url()) &&
          response.status() === 200 &&
          response.request().headers()["if-none-match"] === validator,
      );
      await link.click();
      const changed = await changedRead;
      expect(changed.headers().etag).toBeTruthy();
      expect(changed.headers().etag).not.toBe(validator);
      await expect(card).toContainText(updated);
      await expect(card).not.toContainText(original);
    } finally {
      try {
        await callMCPTool(mcp.client, kind, { action: "delete", ...args });
      } finally {
        await mcp.cleanup();
      }
    }
  });
}
