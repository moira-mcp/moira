/**
 * E2E: a flow in the flow list reads like every list item — the name with its version, what the
 * flow does in up to two readable lines (the whole description on hover), the owner and visibility
 * as a quiet meta line, and a badge only for what needs attention. Deleting is offered only on the
 * reader's own flows; a click opens the flow.
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";
import { TEST_WORKFLOWS } from "./fixtures/test-constants.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
// Public fixture uploaded by global setup; visible to every user in list mode
const PUBLIC_WORKFLOW = TEST_WORKFLOWS.PUBLIC_TEST;
const PUBLIC_WORKFLOW_DESCRIPTION = "Public workflow for testing visibility features";
const TEST_USER = {
  email: "card-test@example.com",
  password: "TestPass123!",
  name: "Card Test User",
};

test.beforeAll(async () => {
  await createTestUser(TEST_USER.email, TEST_USER.password, TEST_USER.name, true);
});

test.describe("Flow list items", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_USER.email, TEST_USER.password);
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForSelector('[data-testid="workflow-explorer"]', {
      state: "visible",
      timeout: 15000,
    });
  });

  test("a list item shows what the flow does below its name, over more than one line", async ({
    page,
  }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    const title = card.locator('[data-slot="card-title"]');
    const description = card.locator('[data-slot="card-description"]');
    await expect(title).toHaveText(PUBLIC_WORKFLOW.name);
    await expect(description).toContainText(PUBLIC_WORKFLOW_DESCRIPTION);
    // The description sits under the name, not squeezed beside it on one line.
    const titleBox = await title.boundingBox();
    const descriptionBox = await description.boundingBox();
    expect(descriptionBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height - 1);
    // The row is a multi-line item, not the old 40-pixel strip.
    expect((await card.boundingBox())!.height).toBeGreaterThan(60);
  });

  test("the meta line names the owner and the visibility in words", async ({ page }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });
    const meta = card.locator('[data-slot="card-meta"]');
    await expect(meta.getByTestId("workflow-card-owner")).toHaveText(/^@\S+/);
    await expect(meta).toContainText(/Public|Публичный/);
  });

  test("a valid flow carries no status badge", async ({ page }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("workflow-card-invalid")).toHaveCount(0);
    await expect(card.getByTestId("workflow-card-unknown")).toHaveCount(0);
  });

  test("a recommended universal flow says when to pick it; another flow does not", async ({
    page,
  }) => {
    // By slug: the name also appears in other universal flows' descriptions, and a page may hold
    // fewer items than those matches
    await page.getByPlaceholder(/Search workflows|Поиск воркфлоу/).fill("quick-task");
    const quickTask = page
      .locator('[data-testid="workflow-card"]')
      .filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^Quick Task$/ }) });
    await expect(quickTask).toHaveCount(1);
    await expect(quickTask.getByTestId("workflow-card-when")).toContainText(
      /Pick it when|Когда выбирать/,
    );

    await page.getByPlaceholder(/Search workflows|Поиск воркфлоу/).fill(PUBLIC_WORKFLOW.name);
    const other = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name });
    await expect(other.first()).toBeVisible();
    await expect(other.first().getByTestId("workflow-card-when")).toHaveCount(0);
  });

  test("the whole description is offered on hover", async ({ page }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.locator('[data-slot="card-description"]').hover();

    // Radix tooltip content appears after its open delay
    await expect(page.locator('[role="tooltip"]')).toContainText(PUBLIC_WORKFLOW_DESCRIPTION);
  });

  test("only your own flows offer delete", async ({ page }) => {
    // Upload a workflow owned by the test user, then hover its card
    const owned = await loadWorkflowFixture(page, TEST_WORKFLOWS.REACT_FLOW_THEME.filename);
    expect(owned.success).toBe(true);
    await page.reload();
    await page.waitForSelector('[data-testid="workflow-explorer"]', { state: "visible" });

    const ownedCard = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: owned.workflowName })
      .first();
    await expect(ownedCard).toBeVisible({ timeout: 10000 });
    await ownedCard.hover();
    await expect(ownedCard.getByRole("button", { name: "Delete Workflow" })).toBeVisible();

    // A public workflow of another owner offers no delete button to this user
    const foreignCard = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await foreignCard.hover();
    await expect(foreignCard.getByRole("button", { name: "Delete Workflow" })).toHaveCount(0);
  });

  test("the Mine tab lists only the reader's own flows and the Catalog tab only others'", async ({
    page,
  }) => {
    const owned = await loadWorkflowFixture(page, TEST_WORKFLOWS.REACT_FLOW_THEME.filename);
    expect(owned.success).toBe(true);
    await page.reload();
    await page.getByTestId("workflow-scope-mine").click();
    const ownedCard = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: owned.workflowName })
      .first();
    await expect(ownedCard).toBeVisible({ timeout: 10000 });
    const myHandle = (await ownedCard.getByTestId("workflow-card-owner").textContent())!.trim();
    const mineOwners = await page.getByTestId("workflow-card-owner").allTextContents();
    expect(mineOwners.every((owner) => owner.trim() === myHandle)).toBe(true);

    await page.getByTestId("workflow-scope-catalog").click();
    await expect(page.locator('[data-testid="workflow-card"]').first()).toBeVisible();
    await expect(
      page.locator('[data-testid="workflow-card"]').filter({ hasText: owned.workflowName }),
    ).toHaveCount(0);
    const catalogOwners = await page.getByTestId("workflow-card-owner").allTextContents();
    expect(catalogOwners.some((owner) => owner.trim() === myHandle)).toBe(false);
  });

  test("the scope tabs control the flow list; the status filter names never-checked flows", async ({
    page,
  }) => {
    const tab = page.getByTestId("workflow-scope-mine");
    const controlled = await tab.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    const list = page.locator(`[id="${controlled}"]`);
    await expect(list).toHaveCount(1);
    await expect(list.locator('[data-testid="workflow-card"]').first()).toBeVisible();

    await page.getByTestId("filters-toggle").click();
    await page.getByTestId("status-filter").click();
    await expect(page.getByRole("option")).toHaveText(["All", "Valid", "Invalid", "Not checked"]);
  });

  test("under name sort, page 2 continues page 1: no flow repeats and none is skipped", async ({
    page,
  }) => {
    // What each answer held, in the order the answers arrived: names repeat among fixtures, so
    // identity comes from the flow ids
    type Answer = { offset: number; ids: string[]; names: string[] };
    const answers: Array<Promise<Answer>> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname !== "/api/workflows" || url.searchParams.get("sort") !== "name") return;
      answers.push(
        response
          .json()
          .then(
            (body: { data: { workflows: Array<{ id: string; metadata: { name: string } }> } }) => ({
              offset: Number(url.searchParams.get("offset")),
              ids: body.data.workflows.map((w) => w.id),
              names: body.data.workflows.map((w) => w.metadata.name),
            }),
          ),
      );
    });
    await page.getByTestId("filters-toggle").click();
    await page.getByTestId("sort-select").click();
    await page.getByRole("option", { name: /(Name|Название).*↑/ }).click();
    const titles = page.locator('[data-testid="workflow-card"] [data-slot="card-title"]');
    await expect(titles.first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const first = await answers[answers.length - 1];
    expect(first.offset).toBe(0);
    expect(first.ids.length).toBeGreaterThan(1);
    await expect(titles).toHaveText(first.names);

    const nextAnswer = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/workflows" &&
        url.searchParams.get("sort") === "name" &&
        url.searchParams.get("offset") !== "0"
      );
    });
    await page.getByTestId("pagination-next").click();
    await nextAnswer;
    await page.waitForLoadState("networkidle");
    const second = await answers[answers.length - 1];
    // Page 2 starts where page 1 ended, shares no flow with it, and is what the list shows
    expect(second.offset).toBe(first.ids.length);
    expect(second.ids.some((id) => first.ids.includes(id))).toBe(false);
    await expect(titles).toHaveText(second.names);
    const both = [...first.names, ...second.names];
    for (let index = 1; index < both.length; index += 1) {
      expect(both[index - 1] <= both[index]).toBe(true);
    }
  });

  test("a click opens the flow", async ({ page }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // Clicking a card routes to the workflow page, which renders the React Flow graph
    await card.click();
    await page.waitForURL(/\/workflows\/[^/]+\/[^/]+$/);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  });
});
