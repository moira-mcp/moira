/**
 * E2E tests for workflow node display in visualization
 *
 * Tests that ALL node types are correctly supported by the API and UI:
 * - start, end, agent-directive, condition, telegram-notification, expression
 *
 * Uses a test fixture workflow, not production workflows.
 *
 * Note: Backend returns raw workflow data. Frontend transforms to ReactFlow format.
 * API tests verify raw workflow structure, UI tests verify frontend visualization.
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

// All supported node types that must be handled
const SUPPORTED_NODE_TYPES = [
  "start",
  "end",
  "agent-directive",
  "condition",
  "telegram-notification",
  "expression",
] as const;

// Test workflow - captured from server response (UUID)
let TEST_WORKFLOW_ID = "";
let TEST_WORKFLOW_SLUG = "";
const TEST_OWNER_HANDLE = "admin"; // Admin user handle for handle/slug URLs

test.describe("Workflow Node Display", () => {
  // Run all tests in this suite serially in one worker to share fixture
  test.describe.configure({ mode: "serial" });

  // Upload test fixture workflow before tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAsAdmin(page);

    const result = await loadWorkflowFixture(page, "all-node-types-test.json", "private");
    if (!result.success) {
      console.error("Failed to upload test fixture workflow");
    } else {
      // Capture the actual server-generated workflowId and slug
      TEST_WORKFLOW_ID = result.workflowId;
      TEST_WORKFLOW_SLUG = result.slug;
      console.log(`Test workflow created: id=${TEST_WORKFLOW_ID}, slug=${TEST_WORKFLOW_SLUG}`);
    }

    await context.close();
  });

  // Cleanup after all tests
  test.afterAll(async ({ browser }) => {
    if (!TEST_WORKFLOW_ID) return; // Skip cleanup if no workflow was created

    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAsAdmin(page);

    // Use UUID for API delete operations
    await page.request.delete(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);

    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("API returns workflow with all node types without error", async ({ page }) => {
    expect(TEST_WORKFLOW_ID).toBeTruthy(); // Ensure workflow was created

    const response = await page.request.get(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);

    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data.workflow).toBeDefined();
    expect(data.data.workflow.id).toBe(TEST_WORKFLOW_ID);

    // Verify raw workflow nodes are present (frontend transforms for visualization)
    expect(data.data.workflow.nodes).toBeDefined();
    expect(Array.isArray(data.data.workflow.nodes)).toBe(true);
    expect(data.data.workflow.nodes.length).toBeGreaterThan(0);
  });

  test("API returns workflow with all node types having valid data", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);

    expect(response.status()).toBe(200);
    const data = await response.json();

    // Check raw workflow nodes (not visualization - frontend transforms)
    const nodes = data.data.workflow.nodes;
    const nodeTypes = new Set(nodes.map((n: { type: string }) => n.type));

    // Verify we have multiple node types
    expect(nodeTypes.size).toBeGreaterThan(1);

    // Each node should have required properties
    for (const node of nodes) {
      expect(node.id).toBeDefined();
      expect(node.type).toBeDefined();
    }
  });

  test("expression nodes have correct raw workflow properties", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);

    expect(response.status()).toBe(200);
    const data = await response.json();

    // Check raw workflow nodes (frontend transforms for visualization)
    const expressionNodes = data.data.workflow.nodes.filter(
      (n: { type: string }) => n.type === "expression",
    );

    // Test workflow should have expression nodes
    expect(expressionNodes.length).toBeGreaterThan(0);

    // Each expression node should have proper data
    for (const node of expressionNodes) {
      expect(node.type).toBe("expression");
      expect(node.id).toBeDefined();
      // Expression nodes should have expressions array
      expect(node.expressions).toBeDefined();
      expect(Array.isArray(node.expressions)).toBe(true);
    }
  });

  test("workflow visualization page loads without errors", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy(); // Ensure workflow was created

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for React Flow to render
    const reactFlowDiv = page.locator(".react-flow").first();
    await expect(reactFlowDiv).toBeVisible({ timeout: 15000 });

    // Verify no error messages are shown
    const errorAlert = page.locator('[role="alert"], .error-message, .error-boundary');
    await expect(errorAlert).toHaveCount(0);
  });

  test("workflow visualization renders nodes on canvas", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy(); // Ensure workflow was created

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for React Flow to render
    const reactFlowDiv = page.locator(".react-flow").first();
    await expect(reactFlowDiv).toBeVisible({ timeout: 15000 });

    // Verify nodes are rendered (frontend transforms raw workflow to ReactFlow)
    const nodeCount = await page.evaluate(() => {
      return document.querySelectorAll(".react-flow__node").length;
    });
    expect(nodeCount).toBeGreaterThan(0);
  });

  test("all supported node types are present in workflow", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);

    expect(response.status()).toBe(200);
    const data = await response.json();

    // Check raw workflow nodes (frontend transforms for visualization)
    const nodes = data.data.workflow.nodes;
    const nodeTypes = nodes.map((n: { type: string }) => n.type);

    // Verify ALL required node types are present in raw workflow
    for (const expectedType of SUPPORTED_NODE_TYPES) {
      expect(nodeTypes).toContain(expectedType);
    }
  });
});
