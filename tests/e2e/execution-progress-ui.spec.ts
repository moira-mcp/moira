import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { callMCPTool, callMCPToolRaw, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const OUTPUT = path.join(
  process.cwd(),
  "moira-ws/software-development-flow-execution-progress-20260827-0024/plans/1/step-3/visual-evidence",
);

test("shows an interactive always-visible progress graph across desktop and mobile states", async ({
  page,
}) => {
  mkdirSync(OUTPUT, { recursive: true });
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

  let mode: "initial" | "middle" | "repair" | "long" | "none" | "error" | "slow" = "initial";
  let releaseSlow: (() => void) | undefined;
  let updatedLabel: string | undefined;
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
    if (mode === "slow") await new Promise<void>((resolve) => (releaseSlow = resolve));
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
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          title:
            mode === "long"
              ? "Software development · independent completeness review"
              : "Software development",
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

  const admin = getAdminCredentials();
  await page.goto(`${BASE_URL}/login`);
  await page.getByRole("textbox", { name: "Email" }).fill(admin.email);
  await page.getByRole("textbox", { name: "Password" }).fill(admin.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL((url) => !url.toString().includes("/login"));
  await page.goto(`${BASE_URL}/executions/${executionId}`);

  const capture = async (name: string) => {
    await expect(page.getByTestId("execution-progress")).toBeVisible();
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: true });
  };
  await capture("desktop-initial");
  for (const state of ["middle", "repair", "long"] as const) {
    mode = state;
    await page.reload();
    await capture(`desktop-${state}`);
  }

  const settledTransform = async () =>
    page.locator(".react-flow__viewport").evaluate(
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
  const activeFocusButton = page.getByTestId("progress-node-stage-1");
  await activeFocusButton.click();
  const activeTransform = await settledTransform();
  const nonActiveFocusButton = page.getByTestId("progress-node-stage-4");
  await nonActiveFocusButton.click();
  const nonActiveTransform = await settledTransform();
  expect(nonActiveTransform).not.toBe(activeTransform);
  await expect(nonActiveFocusButton).toBeFocused();
  await page.getByRole("tab", { name: /Errors|Ошибки/ }).click();
  await expect(page.getByRole("tab", { name: /Errors|Ошибки/ })).toHaveAttribute(
    "data-state",
    "active",
  );

  mode = "slow";
  await page.reload();
  await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("execution-progress-loading")).toBeVisible();
  releaseSlow?.();
  await expect(page.getByTestId("execution-progress")).toBeVisible();

  mode = "middle";
  updatedLabel = "Tests updated from context";
  await page.route(`**/api/executions/${executionId}/context`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { updated: true } }),
    });
  });
  await page.getByRole("tab", { name: /Context|Контекст/ }).click();
  await page.getByTestId("context-var-input-terminal_status").fill("updated");
  await page.getByTestId("context-var-save-terminal_status").click();
  await expect(page.getByTestId("progress-node-stage-2")).toContainText(updatedLabel);

  await page.setViewportSize({ width: 390, height: 844 });
  mode = "middle";
  await page.reload();
  await capture("mobile-middle");
  mode = "error";
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    /temporarily unavailable|временно недоступен/i,
  );
  await expect(page.locator(".react-flow__viewport")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Context|Контекст/ })).toBeVisible();
  mode = "none";
  await page.reload();
  await expect(page.getByText(executionId!.substring(0, 8), { exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("execution-progress")).toHaveCount(0);
  await page.screenshot({ path: path.join(OUTPUT, "mobile-no-progress.png"), fullPage: true });
  await authenticated.cleanup();
});
