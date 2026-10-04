/**
 * E2E: the overview page against the real container, as a fresh person whose runs are all started
 * here through MCP.
 *
 * Stable server ordering retains what the agent asks and the hint to answer in the
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
  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    test(`long task, step, list, stage and child relationship remain contained on ${viewport.label}`, async ({
      page,
    }, testInfo) => {
      const me = await person(page, `long-slots-${viewport.label}`);
      try {
        const parent = await me.start("Parent diagnostic note");
        const parentTitle = `Parent task ${"P".repeat(450)}`;
        const childTitle = `Child task ${"T".repeat(450)}`;
        const ownFlow = `Separate child flow ${"F".repeat(180)}`;
        const stage = `Import stage ${"S".repeat(180)}`;
        const step = `Import one batch ${"C".repeat(180)}`;
        const items = Array.from({ length: 8 }, (_, index) => ({
          title: `Batch ${index + 1}: ${"Long batch description ".repeat(4)}${"I".repeat(100)}`,
        }));
        const childFlow = {
          ...orderImportFlow(ownFlow),
          variableRegistry: {
            plan_steps: { type: "array", description: "Batches to import", default: items },
            current_step: { type: "number", description: "One-based batch cursor", default: 1 },
          },
          progress: {
            nodes: [
              {
                id: "import",
                label: stage,
                content: { summary: "Import the orders batch by batch" },
                list: { items: "plan_steps", title: "title", current: "current_step" },
              },
              { id: "check", label: "Check", content: { summary: "Check the imported orders" } },
            ],
          },
          nodes: orderImportFlow(ownFlow).nodes.map((node) =>
            node.id === "load" ? { ...node, metadata: { displayName: step } } : node,
          ),
        };
        const created = await callMCPTool<{ workflowId: string }>(me.client, "manage", {
          action: "create",
          workflow: childFlow,
        });
        const child = await startWorkflowExecutionState(me.client, created.workflowId, {
          parentExecutionId: parent.processId,
          skipNotificationCheck: true,
          note: "Separate child diagnostic note",
        });
        for (const [executionId, taskTitle] of [
          [parent.processId, parentTitle],
          [child.processId, childTitle],
        ]) {
          const response = await page.request.get(`${BASE_URL}/api/executions/${executionId}`);
          expect(response.status()).toBe(200);
          const detail = (await response.json()).data.execution;
          const updated = await page.request.put(
            `${BASE_URL}/api/executions/${executionId}/task-title`,
            {
              data: {
                taskTitle,
                expectedRevision: detail.revision,
                expectedTaskIdentityRevision: detail.metadataRevisions.taskIdentity,
              },
            },
          );
          expect(updated.status()).toBe(200);
        }
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${BASE_URL}/overview`);
        const shown = card(page, child.processId);
        await expect(shown).toBeVisible();
        await expect(shown).toContainText(childTitle);
        await expect(shown).toContainText(ownFlow);
        await expect(shown).toContainText(parentTitle);
        await expect(shown).toContainText(items[0].title);
        const bounds = await shown.evaluate((element) => {
          const cardBounds = element.getBoundingClientRect();
          return {
            card: element.scrollWidth <= element.clientWidth,
            page: document.documentElement.scrollWidth <= window.innerWidth,
            offendingSlots: Array.from(element.querySelectorAll("[data-testid]")).flatMap(
              (slot) => {
                const bounds = slot.getBoundingClientRect();
                return bounds.left >= cardBounds.left && bounds.right <= cardBounds.right
                  ? []
                  : [
                      {
                        testId: slot.getAttribute("data-testid"),
                        left: bounds.left,
                        right: bounds.right,
                        cardLeft: cardBounds.left,
                        cardRight: cardBounds.right,
                        clientWidth: slot.clientWidth,
                        scrollWidth: slot.scrollWidth,
                      },
                    ];
              },
            ),
          };
        });
        expect(bounds).toEqual({ card: true, page: true, offendingSlots: [] });
        await shown.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`overview-long-child-card-${viewport.label}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await shown.getByTestId("overview-card-open").click();
        const dialog = page.getByTestId("overview-panel");
        await expect(dialog).toHaveAccessibleName(childTitle);
        await expect(dialog).toContainText(ownFlow);
        await expect(dialog.getByTestId("overview-panel-parents")).toContainText(parentTitle);
        await expect(dialog.getByTestId("overview-panel-step")).toHaveText(step);
        await expect(dialog.getByTestId("overview-panel-stages")).toContainText(stage);
        await expect(dialog.getByTestId("overview-panel-list")).toContainText(items[0].title);
        await expect(dialog).toBeInViewport({ ratio: 1 });
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await dialog.getByTestId("overview-panel-list").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`overview-long-child-modal-${viewport.label}.png`),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await me.cleanup();
      }
    });
  }

  for (const surface of ["home", "list", "inspector", "lock-banner"] as const) {
    test(`the owner can stop from ${surface} without card navigation or stale surrounding resources`, async ({
      page,
    }) => {
      const me = await person(page, `stop-${surface}`);
      try {
        const run = await me.start(`Arbitrary note for the ${surface} surface`);
        if (surface === "lock-banner") {
          const locked = await page.request.post(
            `${BASE_URL}/api/executions/${run.processId}/lock`,
            { data: { reason: "Pause before importing" } },
          );
          expect(locked.status()).toBe(200);
        }
        const route =
          surface === "home"
            ? "/"
            : surface === "inspector"
              ? `/executions/${run.processId}`
              : "/executions";
        await page.goto(`${BASE_URL}${route}`);
        const owner =
          surface === "home"
            ? page.getByTestId(`work-active-${run.processId}`)
            : surface === "inspector"
              ? page.getByTestId("run-header")
              : surface === "lock-banner"
                ? page.getByTestId("locked-executions-widget")
                : page.getByTestId("execution-card").filter({ hasText: run.processId.slice(0, 8) });
        await expect(owner).toBeVisible();
        await owner.getByTestId(`execution-stop-${run.processId}`).click();
        await expect(page).toHaveURL(`${BASE_URL}${route}`);
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole("textbox", { name: "Reason for stopping" })
          .fill(`The owner stopped from ${surface}`);
        const response = page.waitForResponse(
          (result) =>
            result.url().endsWith(`/api/executions/${run.processId}/stop`) &&
            result.request().method() === "POST",
        );
        await dialog.getByRole("button", { name: "Stop task", exact: true }).click();
        expect((await response).status()).toBe(200);
        await expect(dialog).toHaveCount(0);
        if (surface === "home") {
          await expect(page.getByTestId(`work-active-${run.processId}`)).toHaveCount(0);
          await expect(page.getByTestId("work-recent")).toContainText("Stopped");
        } else if (surface === "inspector") {
          await expect(page.getByTestId("run-status")).toHaveText("Stopped");
          await expect(page.getByTestId("run-stop-reason")).toContainText(
            `The owner stopped from ${surface}`,
          );
          await expect(
            page.locator(
              '[data-testid="canvas-view"] [data-current="true"], [data-testid="map-contents"] [aria-current="step"]',
            ),
          ).toHaveCount(0);
        } else {
          const stoppedCard = page
            .getByTestId("execution-card")
            .filter({ hasText: run.processId.slice(0, 8) });
          await expect(stoppedCard).toContainText("Stopped");
          await expect(stoppedCard.getByTestId(`execution-stop-${run.processId}`)).toHaveCount(0);
          if (surface === "lock-banner")
            await expect(page.getByTestId("locked-executions-widget")).toHaveCount(0);
        }
      } finally {
        await me.cleanup();
      }
    });
  }

  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    test(`the ${viewport.label} detail retains its identity and scroll through rename and owner stop`, async ({
      page,
    }, testInfo) => {
      const me = await person(page, `modal-${viewport.label}`);
      try {
        const run = await me.start(
          Array.from({ length: 30 }, (_, index) => `Diagnostic ${index}`).join("\n"),
        );
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const rename = async (taskTitle: string) => {
          const response = await page.request.get(`${BASE_URL}/api/executions/${run.processId}`);
          expect(response.status()).toBe(200);
          const detail = (await response.json()).data.execution;
          const updated = await page.request.put(
            `${BASE_URL}/api/executions/${run.processId}/task-title`,
            {
              data: {
                taskTitle,
                expectedRevision: detail.revision,
                expectedTaskIdentityRevision: detail.metadataRevisions.taskIdentity,
              },
            },
          );
          expect(updated.status()).toBe(200);
        };
        const longTitle = `Inspect${"X".repeat(480)}`;
        await rename(longTitle);
        await page.goto(`${BASE_URL}/overview`);
        const shown = card(page, run.processId);
        await expect(shown).toContainText(longTitle);
        expect(await shown.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await shown.getByTestId("overview-card-open").click();
        const dialog = page.getByTestId("overview-panel");
        await expect(dialog).toHaveAccessibleName(longTitle);
        await expect(dialog).toBeInViewport({ ratio: 1 });
        await expect(dialog.getByTestId("overview-panel-open-run")).toBeInViewport({ ratio: 1 });
        await page.screenshot({
          path: testInfo.outputPath(`overview-long-dialog-${viewport.label}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        const initialTitle = "The task is inspected while its detail stays open";
        await rename(initialTitle);
        await expect(shown).toContainText(initialTitle);
        await shown.getByTestId("overview-card-open").click();
        await expect(dialog).toHaveAccessibleName(initialTitle);
        const scroll = dialog.getByTestId("overview-panel-scroll");
        await expect(dialog.getByTestId("overview-panel-stages")).toBeVisible();
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.setAttribute("data-retained-viewport", "same");
        });
        const scrollTop = await scroll.evaluate((element) => element.scrollTop);
        expect(scrollTop).toBeGreaterThan(0);
        const renamed = "The task has changed while its detail stays open";
        await rename(renamed);
        await expect(dialog).toHaveAccessibleName(renamed);
        await expect(scroll).toHaveAttribute("data-retained-viewport", "same");
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(scrollTop);
        await dialog.getByTestId(`execution-stop-${run.processId}`).click();
        const confirmation = page.getByRole("alertdialog");
        await expect(confirmation).toContainText(renamed);
        await confirmation
          .getByRole("textbox", { name: "Reason for stopping" })
          .fill("The owner chose another task");
        await confirmation.getByRole("button", { name: "Stop task", exact: true }).click();
        await expect(confirmation).toHaveCount(0);
        await expect(shown).toHaveCount(0);
        await expect(dialog).toHaveAccessibleName(renamed);
        await expect(dialog.getByTestId("overview-panel-stop-reason")).toContainText(
          "The owner chose another task",
        );
        await expect(scroll).toHaveAttribute("data-retained-viewport", "same");
        await expect(dialog.getByTestId("overview-panel-step")).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`overview-retained-stopped-dialog-${viewport.label}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("main h1")).toBeFocused();
      } finally {
        await me.cleanup();
      }
    });
  }

  test("cards preserve server hour order across waiting states, with the question and where to answer it", async ({
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
      const orderedResponse = await page.request.get(`${BASE_URL}/api/executions/overview`);
      expect(orderedResponse.ok()).toBe(true);
      const ordered = (await orderedResponse.json()).data.runs as Array<{ executionId: string }>;
      const cards = page.getByTestId("overview-card");
      await expect(cards).toHaveCount(2);
      expect(
        await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-run-id")),
        ),
      ).toEqual(ordered.map((row) => row.executionId));
      const askingCard = card(page, asking.processId);
      await expect(askingCard).toHaveAttribute("data-status", "waiting-user");
      await expect(askingCard.getByTestId("overview-waiting")).toContainText(
        "Which currency should the prices use?",
      );

      await askingCard.getByTestId("overview-card-open").click();
      const panel = page.getByRole("dialog");
      await expect(panel).toContainText("Answer the agent in the chat");
      await expect(panel.getByTestId("overview-panel-options")).toContainText("USD");
      await expect(page).toHaveURL(new RegExp(`run=${asking.processId}`));
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(askingCard.getByTestId("overview-card-open")).toBeFocused();
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
      // Wait for the dialog's entrance animation before capturing its bounded position.
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
