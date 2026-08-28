import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { projectExecutionProgress, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { renderExecutionProgressPng } from "../../packages/workflow-engine/src/utils/execution-progress-renderer.js";
import { test, expect } from "./fixtures.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { callMCPTool, callMCPToolRaw, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const OUTPUT = path.join(
  process.cwd(),
  "moira-ws/software-development-flow-execution-progress-20260827-0024/plans/4/step-6/visual-evidence",
);

test("renders the actual SDF phase projection consistently in UI and PNG", async ({ page }) => {
  mkdirSync(OUTPUT, { recursive: true });
  const authenticated = await createAuthenticatedMCPClient();
  const workflow = structuredClone(
    findSystemCatalogEntry("software-development-flow", "public")!.graph,
  ) as WorkflowGraph;
  expect(workflow.metadata.version).toBe("15.3.0");

  const started = await callMCPToolRaw(authenticated.client, "start", {
    workflowId: "moira/software-development-flow",
    parentExecutionId: "none",
    skipTelegramCheck: true,
  });
  const executionId = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
  expect(executionId).toBeTruthy();

  const liveImage = await callMCPTool<{
    downloadUrl: string;
    mimeType: string;
    workflowVersion: string;
  }>(authenticated.client, "session", {
    action: "progress-image-token",
    executionId,
    theme: "light",
    viewportWidth: 960,
  });
  expect(liveImage).toMatchObject({ mimeType: "image/png", workflowVersion: "15.3.0" });
  const liveResponse = await fetch(`${BASE_URL}${new URL(liveImage.downloadUrl).pathname}`);
  expect(liveResponse.status).toBe(200);
  writeFileSync(
    path.join(OUTPUT, "sdf-live-token-initial.png"),
    Buffer.from(await liveResponse.arrayBuffer()),
  );

  const states = {
    plan: { nodeId: "create-plan", status: "running" },
    implement: { nodeId: "prepare-plan-unit-implementation", status: "running" },
    tests: { nodeId: "validate-cheap", status: "running" },
    review: { nodeId: "review-architecture", status: "running" },
    repair: { nodeId: "repair-user-feedback", status: "running" },
    checkpoint: { nodeId: "checkpoint-plan-unit", status: "running" },
    replan: { nodeId: "teleport-replan", status: "running" },
    complete: { nodeId: null, status: "completed" },
  } as const;
  let stateName: keyof typeof states = "plan";
  const projection = (name: keyof typeof states) => {
    const state = states[name];
    return projectExecutionProgress(workflow, {
      id: executionId!,
      workflowId: workflow.id ?? "software-development-flow",
      userId: "visual-evidence-user",
      status: state.status,
      currentNodeId: state.nodeId,
      revision: 12,
      globalContext: {
        variables: {
          plan_revision: 3,
          current_step_index: 2,
          total_steps: 5,
          current_iteration: 4,
        },
        nodeStates: {},
        executionId: executionId!,
        workflowId: workflow.id ?? "software-development-flow",
        currentNodeId: state.nodeId,
      },
    } as unknown as Parameters<typeof projectExecutionProgress>[1]);
  };

  for (const name of Object.keys(states) as Array<keyof typeof states>) {
    const current = projection(name);
    expect(current).not.toBeNull();
    const { png } = await renderExecutionProgressPng(current!, { theme: "light" });
    writeFileSync(path.join(OUTPUT, `sdf-${name}.png`), png);
  }

  await page.route(`**/api/executions/${executionId}/progress`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: projection(stateName) }),
    });
  });

  const admin = getAdminCredentials();
  await page.goto(`${BASE_URL}/login`);
  await page.getByRole("textbox", { name: "Email" }).fill(admin.email);
  await page.getByRole("textbox", { name: "Password" }).fill(admin.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL((url) => !url.toString().includes("/login"));
  await page.goto(`${BASE_URL}/executions/${executionId}`);

  for (const name of Object.keys(states) as Array<keyof typeof states>) {
    stateName = name;
    await page.reload();
    const strip = page.getByTestId("execution-progress");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Software Development · plan r3");
    const expectedProjection = projection(name)!;
    for (const node of expectedProjection.nodes) {
      await expect(page.getByTestId(`progress-node-${node.id}`)).toContainText(node.label);
    }
    const expectedCurrent = expectedProjection.nodes.find((node) => node.state === "current");
    if (expectedCurrent) {
      await expect(page.getByTestId(`progress-node-${expectedCurrent.id}`)).toHaveAttribute(
        "aria-current",
        "step",
      );
    } else {
      await expect(strip.locator('[aria-current="step"]')).toHaveCount(0);
    }
    await page.screenshot({
      path: path.join(OUTPUT, `sdf-ui-desktop-${name}.png`),
      fullPage: true,
    });
  }

  stateName = "review";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("execution-progress")).toBeVisible();
  await expect(page.getByTestId("progress-node-review")).toHaveAttribute("aria-current", "step");
  await page.screenshot({ path: path.join(OUTPUT, "sdf-ui-mobile-review.png"), fullPage: true });

  await authenticated.cleanup();
});
