/** Actual maintained Inspector UI: discovery, strict union editing and a public MCP call. */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { INSPECTOR_URL, isInspectorAvailable } from "./helpers/inspector-oauth-helper.js";

// The token remains in this disposable context and the Inspector's in-memory store.
// The shared logging fixture watches its own page, not this separate context.
test.use({ trace: "off", video: "off", screenshot: "off" });

test("MCP Inspector - workflow list action returns workflows with visibility", async ({
  browser,
}, testInfo) => {
  test.skip(!(await isInspectorAvailable()), "The optional MCP Inspector service is unavailable");
  const authenticated = await createAuthenticatedMCPClient();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const serverId = `moira-catalog-${randomUUID()}`;
  const serverUrl = process.env.INSPECTOR_MCP_URL ?? `${getTestBaseUrl()}/mcp`;
  let stage = "add server";
  let failed = false;
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  try {
    await page.goto(INSPECTOR_URL);
    await page.getByRole("button", { name: "Add Servers", exact: true }).click();
    await page.getByRole("menuitem", { name: "+ Add manually", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add server", exact: true });
    await add.getByRole("textbox", { name: "Server ID", exact: true }).fill(serverId);
    await add.getByRole("textbox", { name: "Transport", exact: true }).click();
    await page.getByRole("option", { name: "streamable-http", exact: true }).click();
    await add.getByRole("textbox", { name: "URL", exact: true }).fill(serverUrl);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add).toHaveCount(0);

    const card = page
      .locator(".mantine-Card-root")
      .filter({ has: page.getByText(serverId, { exact: true }) });
    await expect(card).toHaveCount(1);
    stage = "open owned settings";
    await card.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 5000 });
    stage = "configure authentication header";
    const settings = page.getByRole("dialog", { name: "Server Settings", exact: true });
    const headers = settings.getByRole("button", { name: "Custom Headers", exact: true });
    if ((await headers.getAttribute("aria-expanded")) !== "true") await headers.click();
    await settings.getByRole("button", { name: "+ Add Header", exact: true }).click();
    await settings
      .getByRole("textbox", { name: "header name, row 1", exact: true })
      .fill("Authorization");
    await settings
      .getByRole("textbox", { name: "header value, Authorization, row 1", exact: true })
      .fill(`Bearer ${authenticated.accessToken}`);
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).toHaveCount(0);
    stage = "connect server";
    const connection = page.getByRole("switch", {
      name: `Connect or disconnect "${serverId}"`,
      exact: true,
    });
    await connection.focus();
    await connection.press("Space");
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
    stage = "edit public action";

    // Controls and automation attributes are from maintained Inspector 2.12 source.
    await page.locator('label[for$="-Tools"]').first().click();
    const tools = page.getByTestId("tools-screen");
    await expect(tools).toHaveAttribute("data-tool-count", "16");
    await tools
      .getByRole("button")
      .filter({ has: page.getByText("workflow", { exact: true }) })
      .click();
    const jsonMode = page.getByRole("switch", { name: "Edit as JSON", exact: true });
    if (!(await jsonMode.isChecked())) {
      await jsonMode.focus();
      await jsonMode.press("Space");
    }
    await expect(jsonMode).toBeChecked();
    await page.getByRole("textbox", { name: /^Arguments JSON(?:,|$)/ }).focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(
      JSON.stringify({ action: "list", visibility: "public", limit: 10 }),
    );
    const execute = page.getByRole("button", { name: "Execute Tool", exact: true });
    await expect(execute).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("inspector-workflow-union-editor.png"),
      fullPage: true,
    });
    await execute.click();
    stage = "inspect returned workflows";
    await expect(tools).toHaveAttribute("data-call-status", "ok");
    const output = tools.getByRole("textbox", { name: /^JSON content(?:,|$)/ });
    await expect(output).toBeVisible();
    // Read the value of the actual read-only Ace result widget, not schema/help text.
    const raw = await output.evaluate((element) => {
      const editor = element.closest(".ace_editor") as HTMLElement & {
        env: { editor: { getValue(): string } };
      };
      return editor.env.editor.getValue();
    });
    const result = JSON.parse(raw) as { workflows: Array<Record<string, unknown>> };
    expect(result.workflows.length).toBeGreaterThan(0);
    expect(result.workflows[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      visibility: "public",
      createdAt: expect.any(String),
    });
    await page.screenshot({
      path: testInfo.outputPath("inspector-workflow-list-result.png"),
      fullPage: true,
    });
  } catch (error) {
    failed = true;
    console.error("Inspector gate failed during", stage);
    throw error;
  } finally {
    await page
      .goto("about:blank")
      .catch((error: unknown) => (failed ? undefined : Promise.reject(error)));
    await context.close();
    await authenticated.cleanup();
  }
});
