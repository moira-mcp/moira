import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  startWorkflowExecution,
} from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { systemCatalogGraph } from "../helpers/catalog-graphs.js";

const BASE_URL = getTestBaseUrl();

test("renders live SDF progress in the image endpoint and on the run page", async ({ page }) => {
  const authenticated = await createAuthenticatedMCPClient();

  try {
    const workflow = systemCatalogGraph("software-development-flow", "public");
    const started = await startWorkflowExecution(
      authenticated.client,
      "moira/software-development-flow",
      {
        skipTelegramCheck: true,
      },
    );
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
    expect(liveImage).toMatchObject({
      mimeType: "image/png",
      workflowVersion: workflow.metadata.version,
    });

    const liveResponse = await fetch(`${BASE_URL}${new URL(liveImage.downloadUrl).pathname}`);
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get("content-type")).toMatch(/^image\/png\b/);
    expect(
      Buffer.from(await liveResponse.arrayBuffer())
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");

    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/executions/${executionId}`);

    const progress = page.getByTestId("execution-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText("Software Development · plan r1");
    const intake = page.getByTestId("progress-node-intake");
    await expect(intake).toHaveAccessibleName(/Capture task and repository\s*context.*waiting/i);
    await expect(intake).toHaveAttribute("aria-current", "step");
    await expect(intake).toHaveAttribute("data-status", "waiting");
    // The run waits on the intake step: the variables tab offers the answer form for it.
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("answer-form")).toHaveAttribute(
      "data-node-id",
      "capture-task-and-context",
    );
  } finally {
    await authenticated.cleanup();
  }
});
