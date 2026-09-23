/**
 * Playbooks in the browser.
 *
 * A playbook is named, reusable behaviour text a workflow node references by name. This covers the
 * life a person gives it on screen: writing it, changing it, reading the history of those changes,
 * putting an older version back, and removing it. The history is deliberately the same interface
 * notes and global settings use, so the walk through it here is the same walk.
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { graphOverview } from "./helpers/diagram.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

// The email is set where the user is created, with a random fragment: two workers can load this
// file in the same millisecond, and each must get a user of its own.
const testUser = {
  email: "",
  password: "TestPassword123!",
  name: "Playbooks Test User",
};

test.describe("Playbooks", () => {
  test.beforeAll(async () => {
    testUser.email = `playbooks-test-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
    const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }
  });

  test.beforeEach(async ({ page }) => {
    await login(page, testUser.email, testUser.password);
  });

  test("the sidebar leads to an empty playbooks page", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    const link = page.locator('a[href="/playbooks"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/playbooks/);
    await expect(page.getByTestId("create-playbook-button")).toBeVisible();
    await expect(page.getByTestId("new-playbook-card")).toBeVisible();
  });

  test("a playbook is written, changed, and its history reads back", async ({ page }) => {
    const name = `review-standard-${Date.now()}`;
    await page.goto(`${BASE_URL}/playbooks`);
    await page.waitForLoadState("domcontentloaded");

    // Write it.
    await page.getByTestId("create-playbook-button").click();
    await page.getByTestId("playbook-name-input").fill(name);
    await page.getByTestId("playbook-title-input").fill("Review standard");
    await page.getByTestId("playbook-content-input").fill("First: read the whole diff.");
    await page.getByTestId("save-playbook-button").click();

    const card = page.getByTestId(`playbook-card-${name}`);
    await expect(card).toBeVisible();

    // The card says how a node would reference it, which is the whole point of the name.
    await expect(card).toContainText(name);

    // Change it, so there is a history to read.
    await page.getByTestId(`edit-playbook-${name}`).click();
    await page.getByTestId("playbook-content-input").fill("Second: name the failing case.");
    await page.getByTestId("save-playbook-button").click();
    await expect(page.getByTestId(`playbook-card-${name}`)).toBeVisible();

    // The history is the shared one: the same version list, content pane and restore control.
    await page.getByTestId(`history-playbook-${name}`).click();
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByTestId("version-2")).toBeVisible();

    await page.getByTestId("version-1").click();
    await expect(page.getByTestId("version-content")).toContainText("First: read the whole diff.");

    // A past version is shown beside the current one rather than instead of it.
    await page.getByTestId("side-by-side-tab").click();
    await expect(page.getByTestId("version-content")).toContainText("First: read the whole diff.");
    await expect(page.getByTestId("current-content")).toContainText(
      "Second: name the failing case.",
    );

    // Restoring writes a new version carrying the older text.
    await page.getByTestId("restore-version-button").click();
    await page
      .getByRole("button", { name: /Restore|Восстановить/ })
      .last()
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByTestId(`history-playbook-${name}`).click();
    await expect(page.getByTestId("version-3")).toBeVisible();
    await page.getByTestId("version-3").click();
    await expect(page.getByTestId("version-content")).toContainText("First: read the whole diff.");
    await page.keyboard.press("Escape");

    // Remove it.
    await page.getByTestId(`delete-playbook-${name}`).click();
    await page
      .getByRole("button", { name: /Delete|Удалить/ })
      .last()
      .click();
    await expect(page.getByTestId(`playbook-card-${name}`)).toBeHidden();
  });

  /**
   * The number of running processes an edit will reach.
   *
   * Content resolves at every step, so saving changes behaviour that is already under way. The
   * state that would look the same on a single process is a warning that appears for every edit,
   * so this starts two processes and lets only one of them reference the playbook.
   */
  test("editing warns about the running processes the change will reach", async ({ page }) => {
    const admin = getAdminCredentials();
    const stamp = Date.now();
    const name = `live-warning-${stamp}`;
    const mcp = await createAuthenticatedMCPClient({
      email: admin.email,
      password: admin.password,
    });
    const created: string[] = [];

    const makeFlow = async (flowName: string, directive: string) =>
      (await callMCPTool(mcp.client, "manage", {
        action: "create",
        workflow: {
          metadata: { name: flowName, version: "1.0.0", description: "Live warning" },
          nodes: [
            { id: "start", type: "start", connections: { default: "work" } },
            {
              id: "work",
              type: "agent-directive",
              directive,
              completionCondition: "Done.",
              connections: { success: "end" },
            },
            { id: "end", type: "end" },
          ],
        },
      })) as { workflowId: string };

    try {
      await callMCPTool(mcp.client, "playbooks", {
        action: "save",
        name,
        content: "Say what changed and why.",
      });

      const referencing = await makeFlow(
        `Live warning referencing ${stamp}`,
        `Follow this: {{playbook:${name}}}`,
      );
      const unrelated = await makeFlow(
        `Live warning unrelated ${stamp}`,
        "Do the work without a named standard.",
      );
      created.push(referencing.workflowId, unrelated.workflowId);
      await startWorkflowExecutionState(mcp.client, referencing.workflowId);
      await startWorkflowExecutionState(mcp.client, unrelated.workflowId);

      await login(page, admin.email, admin.password);
      await page.goto(`${BASE_URL}/playbooks`);
      await page.waitForLoadState("domcontentloaded");

      await page.getByTestId(`edit-playbook-${name}`).click();
      const warning = page.getByTestId("playbook-live-runs-warning");
      await expect(warning).toBeVisible();
      // One process, not two: the unrelated run does not read this text.
      await expect(warning).toContainText(/\b1\b/);

      // Leave the editor before removing the playbook: the card carries the delete control.
      await page
        .getByRole("button", { name: /Cancel|Отмена/ })
        .last()
        .click();
      await page.getByTestId(`delete-playbook-${name}`).click();
      await page
        .getByRole("button", { name: /Delete|Удалить/ })
        .last()
        .click();
    } finally {
      for (const workflowId of created) {
        try {
          await callMCPTool(mcp.client, "manage", { action: "delete", workflowId });
        } catch {
          // Cleanup failures are not the subject of this test.
        }
      }
      await mcp.cleanup?.();
    }
  });

  /**
   * A link from a workflow node lands on the playbook it names.
   *
   * The state that looks the same at a glance is a link that opens the playbooks list and leaves the
   * reader to find the playbook; so the landing is checked for the exact playbook — yours in the
   * editor, somebody else's published one read-only, and an unreadable one said to be unavailable.
   */
  test("a node's reference leads to the playbook it names", async ({ page }) => {
    const admin = getAdminCredentials();
    const stamp = Date.now();
    const shared = `linked-standard-${stamp}`;
    const mine = `own-standard-${stamp}`;
    const mcp = await createAuthenticatedMCPClient({
      email: admin.email,
      password: admin.password,
    });
    const adminCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, admin.email, admin.password),
    );
    const profile = await fetch(`${BASE_URL}/api/user/profile`, {
      headers: { Cookie: adminCookie },
    });
    const adminHandle = ((await profile.json()) as { data?: { handle?: string } }).data?.handle;
    expect(adminHandle).toBeTruthy();
    let workflowId = "";

    try {
      await callMCPTool(mcp.client, "playbooks", {
        action: "save",
        name: shared,
        content: "Judge the diff, not the intent.",
      });
      await callMCPTool(mcp.client, "playbooks", {
        action: "visibility",
        name: shared,
        visibility: "public",
      });

      // Another account follows the reference to the published playbook and reads it in place.
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/playbooks?name=${shared}&owner=@${adminHandle}`);
      const linked = page.getByTestId("linked-playbook");
      await expect(linked).toBeVisible();
      await expect(page.getByTestId("linked-playbook-content")).toContainText(
        "Judge the diff, not the intent.",
      );
      await expect(linked).toContainText(`@${adminHandle}/${shared}`);

      // Once unpublished, the same link says the playbook is not available rather than showing a list.
      await callMCPTool(mcp.client, "playbooks", {
        action: "visibility",
        name: shared,
        visibility: "private",
      });
      await page.goto(`${BASE_URL}/playbooks?name=${shared}&owner=@${adminHandle}`);
      await expect(page.getByTestId("linked-playbook-missing")).toBeVisible();

      // The owner, clicking the reference on the flow page, lands in the editor of that playbook —
      // even when the list's first page does not hold it: enough newer playbooks push it off.
      await callMCPTool(mcp.client, "playbooks", { action: "save", name: mine, content: "Mine." });
      for (let i = 0; i < 24; i += 1) {
        await callMCPTool(mcp.client, "playbooks", {
          action: "save",
          name: `${mine}-filler-${i}`,
          content: `Filler ${i}.`,
        });
      }
      const created = (await callMCPTool(mcp.client, "manage", {
        action: "create",
        workflow: {
          metadata: { name: `Linked flow ${stamp}`, version: "1.0.0", description: "Link" },
          // No process view is declared: the reference is read in the node level of the flow
          // page's right panel, which stands beside the graph of a plain definition too.
          nodes: [
            { id: "start", type: "start", connections: { default: "work" } },
            {
              id: "work",
              type: "agent-directive",
              directive: `Follow this: {{playbook:${mine}}}`,
              completionCondition: "Done.",
              connections: { success: "end" },
            },
            { id: "end", type: "end" },
          ],
        },
      })) as { workflowId: string };
      workflowId = created.workflowId;

      await login(page, admin.email, admin.password);
      // A tall viewport keeps the list's sticky pagination bar off the cards this test clicks.
      await page.setViewportSize({ width: 1280, height: 1400 });
      await page.goto(`${BASE_URL}/workflows/${workflowId}?view=graph`);
      await expect(page.locator('[data-graph-node="work"]')).toBeVisible({ timeout: 20000 });
      // The graph opens on its first step; the card after it may lie past the pane's edge.
      await graphOverview(page);
      await page.locator('[data-graph-node="work"]').click();
      await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "work");
      await page.getByTestId(`playbook-reference-${mine}`).click();
      await expect(page).toHaveURL(/\/playbooks/);
      const landing = page.getByTestId("linked-playbook-editor");
      await expect(landing).toBeVisible();
      await expect(page.getByTestId(`playbook-card-${mine}`)).toBeHidden();
      await expect(page.getByTestId("playbook-name-input")).toHaveValue(mine);
      await expect(page.getByTestId("playbook-content-input")).toHaveValue("Mine.");

      // The landing slot does not silence the list: editing a card from it opens that card's editor
      // and closes the slot.
      const other = `${mine}-filler-23`;
      await page.getByTestId(`edit-playbook-${other}`).click();
      await expect(page.getByTestId("linked-playbook-editor")).toBeHidden();
      await expect(page.getByTestId("playbook-name-input")).toHaveValue(other);
    } finally {
      if (workflowId) {
        try {
          await callMCPTool(mcp.client, "manage", { action: "delete", workflowId });
        } catch {
          // Cleanup failures are not the subject of this test.
        }
      }
      const fillers = Array.from({ length: 24 }, (_, i) => `${mine}-filler-${i}`);
      for (const name of [shared, mine, ...fillers]) {
        try {
          await callMCPTool(mcp.client, "playbooks", { action: "delete", name });
        } catch {
          // Same.
        }
      }
      await mcp.cleanup?.();
    }
  });

  test("publishing is a visible state, not a hidden setting", async ({ page }) => {
    const name = `tone-of-voice-${Date.now()}`;
    await page.goto(`${BASE_URL}/playbooks`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("create-playbook-button").click();
    await page.getByTestId("playbook-name-input").fill(name);
    await page.getByTestId("playbook-content-input").fill("Write plainly.");
    await page.getByTestId("save-playbook-button").click();

    const badge = page.getByTestId(`playbook-visibility-${name}`);
    await expect(badge).toHaveAttribute("data-visibility", "private");

    await page.getByTestId(`edit-playbook-${name}`).click();
    await page.getByTestId("playbook-visibility-toggle").click();
    await expect(page.getByTestId("playbook-visibility-toggle")).toHaveAttribute(
      "data-visibility",
      "public",
    );

    await page.getByTestId("save-playbook-button").click();
    await expect(page.getByTestId(`playbook-visibility-${name}`)).toHaveAttribute(
      "data-visibility",
      "public",
    );

    await page.getByTestId(`delete-playbook-${name}`).click();
    await page
      .getByRole("button", { name: /Delete|Удалить/ })
      .last()
      .click();
  });
});
