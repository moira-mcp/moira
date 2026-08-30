import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { callMCPTool, callMCPToolRaw, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

type ProgressMode = "initial" | "middle" | "repair" | "long" | "none" | "error" | "slow";

async function openProgressExecution(page: Page) {
  const authenticated = await createAuthenticatedMCPClient();
  const workflow = await callMCPTool<any>(authenticated.client, "manage", {
    action: "get",
    workflowId: "moira/verified-research",
  });
  const agentIds = workflow.nodes
    .filter((node: any) => node.type === "agent-directive")
    .map((node: any) => node.id);
  const focusIds = [
    agentIds[0],
    agentIds[Math.floor(agentIds.length / 3)],
    agentIds[Math.floor((agentIds.length * 2) / 3)],
    agentIds[agentIds.length - 1],
  ];
  const started = await callMCPToolRaw(authenticated.client, "start", {
    workflowId: "moira/verified-research",
    parentExecutionId: "none",
    skipTelegramCheck: true,
  });
  const executionId = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
  expect(executionId).toBeTruthy();

  let mode: ProgressMode = "initial";
  let updatedLabel: string | undefined;
  let releaseSlow: (() => void) | undefined;
  let markSlowRequestStarted: (() => void) | undefined;
  const slowRequestStarted = new Promise<void>((resolve) => {
    markSlowRequestStarted = resolve;
  });

  await page.route(`**/api/executions/${executionId}/progress`, async (route) => {
    if (mode === "none") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"none"}',
      });
      return;
    }
    if (mode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"failed"}',
      });
      return;
    }
    if (mode === "slow") {
      markSlowRequestStarted?.();
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
    }
    const active = mode === "initial" ? 0 : mode === "middle" ? 2 : mode === "repair" ? 3 : 1;
    const labels = ["Plan", "Implementation", "Tests", "Independent review", "Repair"];
    const nodes = labels.map((label, index) => ({
      id: `stage-${index}`,
      label:
        updatedLabel && index === 2
          ? updatedLabel
          : mode === "long" && index === 1
            ? "Implementation and documentation for a deliberately long execution milestone"
            : label,
      state: index < active ? "completed" : index === active ? "current" : "pending",
      connections: { default: index === 4 ? "stage-1" : `stage-${index + 1}` },
      primaryNodeIds: [focusIds[Math.min(index, focusIds.length - 1)]],
      focusNodeId: focusIds[Math.min(index, focusIds.length - 1)],
      content: { summary: null, details: [], outcome: null, next: null },
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          taskTitle: "Progress graph E2E",
          title:
            mode === "long"
              ? "Software development · independent completeness review"
              : "Software development",
          goal: null,
          facts: [],
          activeNodeId: `stage-${active}`,
          nodes,
          workflowVersion: "1.0.0",
          executionRevision: active + 1,
          executionStatus: "running",
          diagnostics: [],
        },
      }),
    });
  });

  await loginAsAdmin(page);
  await page.goto(`${BASE_URL}/executions/${executionId}`);
  await expect(page.getByTestId("execution-progress")).toBeVisible();
  await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });

  return {
    executionId: executionId!,
    setMode(next: ProgressMode) {
      mode = next;
    },
    setUpdatedLabel(label: string) {
      updatedLabel = label;
    },
    slowRequestStarted,
    releaseSlow() {
      releaseSlow?.();
    },
    cleanup: authenticated.cleanup,
  };
}

async function settledTransform(page: Page) {
  return page.locator(".react-flow__viewport").evaluate(
    (element) =>
      new Promise<string>((resolve) => {
        let previous = element.getAttribute("style") || "";
        let stableFrames = 0;
        const observe = () => {
          const current = element.getAttribute("style") || "";
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 5) resolve(current);
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      }),
  );
}

test("shows desktop progress states and focuses primary workflow nodes", async ({ page }) => {
  const progress = await openProgressExecution(page);
  try {
    for (const state of ["middle", "repair", "long"] as const) {
      progress.setMode(state);
      await page.reload();
      await expect(page.getByTestId("execution-progress")).toBeVisible();
    }
    const workflowViewport = page.locator(".react-flow__viewport");
    const initialTransform = await workflowViewport.getAttribute("style");
    await page.locator(".react-flow__controls-zoomin").click();
    await expect.poll(() => workflowViewport.getAttribute("style")).not.toBe(initialTransform);
    const zoomedTransform = await settledTransform(page);
    const nonActiveFocusButton = page.getByTestId("progress-node-stage-4");
    await nonActiveFocusButton.click();
    await expect.poll(() => workflowViewport.getAttribute("style")).not.toBe(zoomedTransform);
    expect(await settledTransform(page)).not.toBe(zoomedTransform);
    await expect(nonActiveFocusButton).toBeFocused();
    await page.getByRole("tab", { name: /Errors|Ошибки/ }).click();
    await expect(page.getByRole("tab", { name: /Errors|Ошибки/ })).toHaveAttribute(
      "data-state",
      "active",
    );
  } finally {
    await progress.cleanup();
  }
});

test("shows loading state and refreshes context-derived progress content", async ({ page }) => {
  const progress = await openProgressExecution(page);
  try {
    progress.setMode("slow");
    const reload = page.reload({ waitUntil: "domcontentloaded" });
    await progress.slowRequestStarted;
    await expect(page.getByTestId("execution-progress-loading")).toBeVisible();
    progress.releaseSlow();
    await reload;
    await expect(page.getByTestId("execution-progress")).toBeVisible();

    progress.setMode("middle");
    progress.setUpdatedLabel("Tests updated from context");
    await page.reload();
    await expect(page.getByTestId("progress-node-stage-2")).toContainText(
      "Tests updated from context",
    );
  } finally {
    progress.releaseSlow();
    await progress.cleanup();
  }
});

test("keeps the workflow usable across mobile progress error and absence states", async ({
  page,
}) => {
  const progress = await openProgressExecution(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    progress.setMode("middle");
    const middleResponse = page.waitForResponse(
      (response) => response.url().endsWith("/progress") && response.status() === 200,
    );
    await page.reload();
    await middleResponse;
    await expect(page.getByTestId("execution-progress")).toBeVisible();

    progress.setMode("error");
    const errorResponse = page.waitForResponse(
      (response) => response.url().endsWith("/progress") && response.status() === 500,
    );
    await page.reload();
    await errorResponse;
    await expect(page.getByRole("status")).toContainText(
      /temporarily unavailable|временно недоступен/i,
    );
    await expect(page.locator(".react-flow__viewport")).toBeVisible();
    await expect(page.getByRole("tab", { name: /Context|Контекст/ })).toBeVisible();

    progress.setMode("none");
    const absentResponse = page.waitForResponse(
      (response) => response.url().endsWith("/progress") && response.status() === 404,
    );
    await page.reload();
    await absentResponse;
    await expect(
      page.getByText(progress.executionId.substring(0, 8), { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("execution-progress")).toHaveCount(0);
  } finally {
    await progress.cleanup();
  }
});
