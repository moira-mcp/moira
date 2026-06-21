/**
 * E2E Tests for MCP Tools via Inspector
 * Tests MCP tool functionality through Inspector with OAuth
 *
 * REQUIRES: MCP Inspector running on localhost:6274
 * If Inspector not available, tests are automatically skipped.
 */

import { test, expect } from "./fixtures.js";
import {
  connectInspectorWithOAuth,
  InspectorUser,
  isInspectorAvailable,
} from "./helpers/inspector-oauth-helper.js";

// Check Inspector availability before each test
test.beforeEach(async () => {
  const available = await isInspectorAvailable();
  test.skip(!available, "MCP Inspector is not running. Start it with: npm run inspector");
});

/**
 * Helper function to find a tool in the Inspector using multiple selector strategies.
 * Tries different selectors with cascading fallbacks for UI resilience.
 */
async function findToolByName(page: any, toolName: string, timeout: number = 5000) {
  const strategies = [
    // Strategy 1: Try button role with case-insensitive regex
    () => page.getByRole("button", { name: new RegExp(`^${toolName}$`, "i") }).first(),
    // Strategy 2: Try exact text match
    () => page.getByText(toolName, { exact: true }).first(),
    // Strategy 3: Try within tool-related elements
    () =>
      page
        .locator('[data-testid*="tool"], [class*="tool"]')
        .getByText(toolName, { exact: true })
        .first(),
  ];

  for (const getLocator of strategies) {
    const locator = getLocator();
    const isVisible = await locator.isVisible({ timeout }).catch(() => false);
    if (isVisible) {
      return locator;
    }
  }

  return null;
}

test("MCP Inspector - list tool returns workflows with visibility", async ({ page }) => {
  // Increase timeout for this test as MCP connection can be slow
  test.setTimeout(90000);

  const TEST_USER: InspectorUser = {
    email: "mcp-tools-test@example.com",
    password: "ToolsPass123!",
    name: "MCP Tools Test",
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  };

  // Setup network listener FIRST (before navigating to Inspector)
  const mcpResponses: any[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/mcp") && response.request().method() === "POST") {
      try {
        const text = await response.text();
        mcpResponses.push({ url: response.url(), body: text });
      } catch (e) {
        // Ignore
      }
    }
  });

  // Complete OAuth flow and connect to Inspector
  await connectInspectorWithOAuth(page, TEST_USER, { verbose: false });

  // Give MCP connection time to establish and tools to load
  await page.waitForTimeout(3000);

  // Try multiple times to find tools - MCP connection may take time to fully establish
  let listWorkflowsTool = null;
  const TOOL_SELECTOR_TIMEOUT = 10000;
  const MAX_RETRIES = 3;

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    // Click List Tools button if it exists and wait for tools to appear
    const listToolsBtn = page.getByRole("button", { name: "List Tools" });
    const isListToolsVisible = await listToolsBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (isListToolsVisible) {
      await listToolsBtn.click();
      // Give tools panel time to expand and render tools
      await page.waitForTimeout(2000);
    }

    // Find and click list tool (wait until visible) - try different selectors
    listWorkflowsTool = await findToolByName(page, "list", TOOL_SELECTOR_TIMEOUT);

    if (listWorkflowsTool) {
      break;
    }

    // Wait before retry
    if (retry < MAX_RETRIES - 1) {
      console.log(`Retry ${retry + 1}/${MAX_RETRIES}: Tool 'list' not found, waiting...`);
      await page.waitForTimeout(3000);
    }
  }

  if (!listWorkflowsTool) {
    // Take screenshot for debugging
    await page.screenshot({ path: "test-results/artifacts/inspector-tools-not-found.png" });
    throw new Error(
      "Could not find 'list' tool in the Inspector tools panel after OAuth connection",
    );
  }

  await expect(listWorkflowsTool).toBeVisible({ timeout: 10000 });

  await listWorkflowsTool.click();

  // Click Run Tool
  const runToolBtn = page.getByRole("button", { name: "Run Tool" });
  await runToolBtn.click();

  // Wait for tool execution result
  await expect(page.locator("text=tools/call")).toBeVisible({ timeout: 10000 });

  // Wait for result to show up in the page
  await page.waitForLoadState("domcontentloaded");

  // Give extra time for MCP response to be captured
  await page.waitForTimeout(2000);

  // Parse MCP responses and find list_workflows result
  let workflowsData: any[] | null = null;

  console.log(`→ Total MCP responses captured: ${mcpResponses.length}`);
  for (let idx = 0; idx < mcpResponses.length; idx++) {
    const resp = mcpResponses[idx];

    // Parse SSE format (event: message\ndata: {...}) or direct JSON
    const lines = resp.body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Try SSE format: data: {...}
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.substring(6));

          // Look for result.content with text (tools/call response)
          if (data.result?.content?.[0]?.text) {
            const text = data.result.content[0].text;

            // Try parsing as JSON - could be array or { workflows: [...], total }
            try {
              const parsed = JSON.parse(text);
              // New format: { workflows: [...], total: number }
              if (
                parsed.workflows &&
                Array.isArray(parsed.workflows) &&
                parsed.workflows.length > 0
              ) {
                workflowsData = parsed.workflows;
                console.log(
                  `→ Found workflows object, workflows.length: ${parsed.workflows.length}, total: ${parsed.total}`,
                );
                break;
              }
              // Old format: direct array
              if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
                workflowsData = parsed;
                console.log(`→ Found workflows array, length: ${parsed.length}`);
                break;
              }
            } catch (e) {
              // Not a workflows response
            }
          }
        } catch (e) {
          // Not JSON
        }
      }

      // Try direct JSON format (non-SSE)
      if (line.startsWith("{")) {
        try {
          const data = JSON.parse(line);
          if (data.result?.content?.[0]?.text) {
            const text = data.result.content[0].text;
            try {
              const parsed = JSON.parse(text);
              if (parsed.workflows && Array.isArray(parsed.workflows)) {
                workflowsData = parsed.workflows;
                console.log(`→ Found workflows (direct JSON), length: ${parsed.workflows.length}`);
                break;
              }
            } catch (e) {
              // Not a workflows response
            }
          }
        } catch (e) {
          // Not JSON
        }
      }
    }
    if (workflowsData) break;
  }

  // Verify workflows returned with visibility
  expect(workflowsData).not.toBeNull();
  expect(workflowsData!.length).toBeGreaterThan(0);

  // Check first workflow has required fields (id, name, visibility, createdAt)
  const firstWorkflow = workflowsData![0];
  expect(firstWorkflow).toHaveProperty("id");
  expect(firstWorkflow).toHaveProperty("name");
  expect(firstWorkflow).toHaveProperty("visibility");
  expect(firstWorkflow).toHaveProperty("createdAt");

  console.log(`✓ list tool returned ${workflowsData!.length} workflows with visibility field`);
});
