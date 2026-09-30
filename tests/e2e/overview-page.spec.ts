/**
 * E2E: the overview page against the real container, as a fresh person whose runs are all started
 * here through MCP.
 *
 * A run waiting for the person comes first, with what the agent asks and the hint to answer in the
 * chat; a step the agent hands in shows on the open page without a reload; the filter by time
 * without movement keeps only the runs untouched since the cut (the cut is read from the server's
 * own timestamps, since a run's last step cannot be backdated), and nothing that just moved counts
 * as idle for a week.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";
import { createTestUser, login } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "Overview-Password-1";

/** Two stages, one step each: the card shows "Stage 1 of 2", then "Stage 2 of 2". */
function orderImportFlow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "Import orders, then check them" },
    progress: {
      nodes: [
        { id: "import", label: "Import", content: { summary: "Import the orders" } },
        { id: "check", label: "Check", content: { summary: "Check the imported orders" } },
      ],
    },
    nodes: [
      { type: "start", id: "start", progressNodeId: "import", connections: { default: "load" } },
      {
        type: "agent-directive",
        id: "load",
        progressNodeId: "import",
        directive: "Import the orders from the CSV file",
        completionCondition: "Imported",
        connections: { success: "verify" },
        connectionLabels: { success: "imported" },
      },
      {
        type: "agent-directive",
        id: "verify",
        progressNodeId: "check",
        directive: "Check the imported orders",
        completionCondition: "Checked",
        connections: { success: "end" },
      },
      { type: "end", id: "end", progressNodeId: "check" },
    ],
  };
}

interface Person {
  client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  cleanup: () => Promise<void>;
  workflowId: string;
  start(note: string): Promise<RunningWorkflowExecution>;
}

async function person(page: Page, label: string): Promise<Person> {
  const email = `overview-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await createTestUser(email, PASSWORD, `Overview ${label}`)).success).toBe(true);
  const mcp = await createAuthenticatedMCPClient({ email, password: PASSWORD });
  const created = await callMCPTool<{ workflowId: string }>(mcp.client, "manage", {
    action: "create",
    workflow: orderImportFlow(`Order import ${label} ${Date.now()}`),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, email, PASSWORD);
  return {
    client: mcp.client,
    cleanup: mcp.cleanup,
    workflowId: created.workflowId,
    start: (note) =>
      startWorkflowExecutionState(mcp.client, created.workflowId, {
        note,
        skipNotificationCheck: true,
      }),
  };
}

const card = (page: Page, executionId: string) =>
  page.locator(`[data-testid="overview-card"][data-run-id="${executionId}"]`);

test.describe("The overview", () => {
  test("a run waiting for you comes first, with the question and where to answer it", async ({
    page,
  }) => {
    const me = await person(page, "first");
    try {
      const asking = await me.start("Import March orders");
      const busy = await me.start("Import April orders");
      // The newer run moved last, so by activity alone it would lead.
      await advanceWorkflowExecution(me.client, busy, {});
      await callMCPTool(me.client, "session", {
        action: "await-user",
        executionId: asking.processId,
        question: "Which currency should the prices use?",
        options: ["EUR", "USD"],
      });

      await page.goto(`${BASE_URL}/overview`);
      const cards = page.getByTestId("overview-card");
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toHaveAttribute("data-run-id", asking.processId);
      await expect(cards.first()).toHaveAttribute("data-status", "waiting-user");
      await expect(cards.first().getByTestId("overview-waiting")).toContainText(
        "Which currency should the prices use?",
      );

      await cards.first().getByTestId("overview-card-open").click();
      const panel = page.getByRole("dialog");
      await expect(panel).toContainText("Answer the agent in the chat");
      await expect(panel.getByTestId("overview-panel-options")).toContainText("USD");
      await expect(page).toHaveURL(new RegExp(`run=${asking.processId}`));
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(cards.first().getByTestId("overview-card-open")).toBeFocused();
    } finally {
      await me.cleanup();
    }
  });

  test("a step the agent hands in shows on the open page without a reload", async ({ page }) => {
    const me = await person(page, "live");
    try {
      const run = await me.start("Import May orders");
      await page.goto(`${BASE_URL}/overview`);
      await expect(page.getByTestId("overview-connection")).toHaveAttribute("data-state", "live", {
        timeout: 20000,
      });
      const shown = card(page, run.processId);
      await expect(shown.getByTestId("overview-plan")).toContainText("Import");
      await expect(shown.locator('[data-current="true"]')).toContainText("Import");
      // A marker on the window: a reload would drop it.
      await page.evaluate(() => {
        (window as unknown as { overviewMarker: boolean }).overviewMarker = true;
      });

      await advanceWorkflowExecution(me.client, run, {});
      await expect(shown.locator('[data-current="true"]')).toContainText("Check", {
        timeout: 20000,
      });
      expect(
        await page.evaluate(
          () => (window as unknown as { overviewMarker?: boolean }).overviewMarker === true,
        ),
      ).toBe(true);
    } finally {
      await me.cleanup();
    }
  });

  test("an agent-stopped run leaves In progress live and remains distinct from Completed", async ({
    page,
  }, testInfo) => {
    const me = await person(page, "stopped");
    const reason =
      "The user cancelled this import and asked the agent to investigate a different task. The completed import stage remains recorded; checking was not completed.";
    try {
      const run = await me.start("Import stopped orders");
      await advanceWorkflowExecution(me.client, run, {});
      await page.goto(`${BASE_URL}/overview`);
      await expect(page.getByTestId("overview-connection")).toHaveAttribute("data-state", "live");
      const shown = card(page, run.processId);
      await expect(shown).toBeVisible();
      await expect(shown.locator('[data-current="true"]')).toContainText("Check");
      await page.evaluate(() => {
        (window as unknown as { overviewMarker: boolean }).overviewMarker = true;
      });
      const context = await callMCPTool<{ revision: number }>(me.client, "session", {
        action: "execution_context",
        executionId: run.processId,
      });
      expect(context.revision).toEqual(expect.any(Number));
      await callMCPTool(me.client, "session", {
        action: "stop-execution",
        executionId: run.processId,
        expectedRevision: context.revision,
        reason,
      });
      await expect(shown).toHaveCount(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { overviewMarker?: boolean }).overviewMarker,
        ),
      ).toBe(true);
      await page.getByTestId("overview-status-stopped").click();
      await expect(shown).toBeVisible();
      await expect(shown).toHaveAttribute("data-status", "stopped");
      await expect(shown.getByTestId("overview-status")).toHaveText("Stopped");
      await expect(shown.getByTestId("overview-stop-reason")).toHaveText(reason);
      await expect(shown.locator('[data-done="true"]')).toContainText("Import");
      await expect(shown.locator('[data-current="true"]')).toHaveCount(0);
      await expect(
        shown.getByTestId("overview-plan-item").filter({ hasText: "Check" }),
      ).not.toHaveAttribute("data-done", "true");
      await page.screenshot({
        path: testInfo.outputPath("overview-stopped-desktop.png"),
        fullPage: true,
      });
      await page.getByTestId("overview-status-completed").click();
      await expect(shown).toHaveCount(0);
      await page.getByTestId("overview-status-stopped").click();
      await shown.getByTestId("overview-card-open").click();
      const panel = page.getByRole("dialog");
      await expect(panel.getByTestId("overview-panel-stop-reason")).toContainText(reason);
      await expect(panel.getByTestId("overview-panel-facts")).toContainText("Stopped");
      await expect(panel.getByTestId("overview-panel-facts")).not.toContainText("Completed");
      await expect(panel.getByTestId("overview-panel-step")).toHaveCount(0);
      // Text is present before the sheet finishes sliding in; capture only its settled position.
      await panel.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expect(panel.getByTestId("overview-panel-stop-reason")).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath("overview-stopped-panel-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await panel.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expect(panel.getByTestId("overview-panel-stop-reason")).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath("overview-stopped-panel-mobile.png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(shown).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath("overview-stopped-mobile.png"),
        fullPage: true,
      });
      await shown.getByTestId("overview-card-open").click();
      await page.getByTestId("overview-panel-open-run").click();
      await expect(page.getByTestId("run-status")).toHaveText("Stopped");
      await expect(page.getByTestId("run-stop-reason")).toContainText(reason);
    } finally {
      await me.cleanup();
    }
  });

  test("the filter by time without movement keeps only the runs untouched since the cut", async ({
    page,
  }) => {
    const me = await person(page, "idle");
    try {
      const older = await me.start("Import June orders");
      // The cut is the older run's own last step, as the server stamped it.
      const rows = await page.request.get(
        `${BASE_URL}/api/executions/overview?ids=${older.processId}`,
      );
      expect(rows.ok()).toBe(true);
      const [row] = (await rows.json()).data.runs as Array<{ subtreeActivityAt: number }>;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const newer = await me.start("Import July orders");

      await page.goto(`${BASE_URL}/overview?activeTo=${row.subtreeActivityAt}`);
      await expect(page.getByTestId("overview-card")).toHaveCount(1);
      await expect(card(page, older.processId)).toBeVisible();
      await expect(card(page, newer.processId)).toHaveCount(0);

      // Neither run has stood still for a week.
      await page.goto(`${BASE_URL}/overview`);
      await expect(page.getByTestId("overview-card")).toHaveCount(2);
      await page.getByTestId("overview-stale").click();
      await expect(page).toHaveURL(/idle=7d/);
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await expect(page.getByTestId("overview-card")).toHaveCount(0);

      // The other filters open beside their button, on screen.
      await page.getByTestId("overview-filters").click();
      await expect(page.getByTestId("overview-filters-popover")).toBeInViewport();
    } finally {
      await me.cleanup();
    }
  });

  test("the search box follows the address when a link changes it", async ({ page }) => {
    const me = await person(page, "search");
    try {
      await me.start("Import October orders");
      await me.start("Import November orders");
      await page.goto(`${BASE_URL}/overview`);
      await expect(page.getByTestId("overview-card")).toHaveCount(2);
      await page.getByTestId("overview-search").fill("October");
      await expect(page).toHaveURL(/q=October/);
      await expect(page.getByTestId("overview-card")).toHaveCount(1);

      // The sidebar's link opens the overview without a search.
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await expect(page).not.toHaveURL(/q=/);
      await expect(page.getByTestId("overview-search")).toHaveValue("");
      await expect(page.getByTestId("overview-card")).toHaveCount(2);
    } finally {
      await me.cleanup();
    }
  });
});
