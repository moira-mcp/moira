/**
 * A Software Development Flow run, rendered both as the progress image the agent can hand over
 * and as the run page's map: the intake block waits for the agent, the answer form offers the
 * step it waits on, and the implement block — the one bound to the plan's unit list — shows how
 * much of that list is done on its card and in its panel.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { systemCatalogGraph } from "../helpers/catalog-graphs.js";

const BASE_URL = getTestBaseUrl();

/** A measured duration as the interface writes it: `12 s`, `1 min 20 s`, `2 h 05 min`. */
const DURATION = /^\d+\s(s|min|h|с|мин|ч)\b/;

test("renders live SDF progress in the image endpoint and on the run page", async ({ page }) => {
  const authenticated = await createAuthenticatedMCPClient();

  try {
    const workflow = systemCatalogGraph("software-development-flow", "public");
    const run = await startWorkflowExecutionState(
      authenticated.client,
      "moira/software-development-flow",
      { skipTelegramCheck: true },
    );
    const executionId = run.processId;

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

    // Answer the intake step through MCP, so the block has a measured pass behind it.
    await advanceWorkflowExecution(authenticated.client, run, {
      workspace_path: "./moira-ws/sdf-e2e",
      operating_mode: "autonomous",
      visual_validation_preference: "disabled",
      progress_intake_outcome: "Task and repository context captured",
    });

    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${executionId}`);

    const progress = page.getByTestId("execution-progress");
    await expect(progress).toBeVisible();
    // The toolbar names the workflow the run belongs to. (The projection's own rendered title,
    // `Software Development · plan r1`, its goal and its facts had their surface in the removed
    // lanes header and are not shown by either of the two views.)
    await expect(page.getByTestId("run-page")).toContainText(/Software Development/);
    const intake = page.locator('[data-testid="canvas-view"] [data-block-id="intake"]');
    await expect(intake).toHaveAttribute("data-current", "true");
    await expect(intake).toHaveAttribute("data-status", "waiting");
    // The run waits on an agent step, not on a person.
    await expect(intake).toContainText(/agent on the step/i);
    // The answered pass is measured, so the panel carries a duration rather than "—" and the
    // card carries a time fact of its own. The two are not compared: the block is still open, so
    // the card shows the running pass while the panel shows the total, and they tick apart.
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "intake");
    await expect(page.getByTestId("block-timings")).toHaveAttribute("data-recorded", "true");
    await expect(page.getByTestId("block-timing-total")).not.toHaveText("—");
    await expect(intake.locator("[data-step-facts] > *").filter({ hasText: DURATION })).toHaveCount(
      1,
    );

    // The implement block is bound to the plan's unit list, so it reports how much of that list
    // is done — on its card on the map and, once selected, in its panel.
    await expect(
      page.getByTestId("map-contents-implement").locator("[data-contents-list]"),
    ).toHaveText(/^\d+\/\d+$/);
    await page.getByTestId("map-contents-implement").click();
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "implement");
    await expect(page.getByTestId("block-list-progress")).toHaveText(/\d+ of \d+ done/);

    // The variables tab offers the answer form for the step the run now waits on.
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("answer-form")).toBeVisible();
  } finally {
    await authenticated.cleanup();
  }
});
