/**
 * E2E: every list page draws its items as the one CardShell item — a title the reader scans for,
 * the readable description under it and a quiet meta line — instead of the old single 40-pixel
 * strip, and an item that opens on click also opens from the keyboard through its title. Notes,
 * artifacts, executions and the administrator's users, audit log and workflows are the sample.
 */

import { test, expect, type Locator, type Page } from "./fixtures.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { TEST_WORKFLOWS } from "./fixtures/test-constants.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

/** The item reads as a slotted CardShell item over more than one line. */
async function expectSlottedItem(item: Locator): Promise<void> {
  await expect(item).toHaveAttribute("data-slotted", "true");
  await expect(item.locator('[data-slot="card-title"]')).toBeVisible();
  await expect(item.locator('[data-slot="card-meta"]')).toBeVisible();
  expect((await item.boundingBox())!.height).toBeGreaterThan(56);
}

async function openListView(page: Page, path: string, firstItem: string): Promise<Locator> {
  await page.goto(`${BASE_URL}${path}`);
  await page.getByTestId("view-mode-list").click();
  const item = page.locator(firstItem).first();
  await expect(item).toBeVisible({ timeout: 15000 });
  return item;
}

test.describe("List items", () => {
  test("a note is a slotted item: key, text under it, tags and size; Enter on its title opens it", async ({
    page,
  }) => {
    const email = `list-items-${Date.now()}@example.com`;
    expect((await createTestUser(email, PASSWORD, "List Items")).success).toBe(true);
    await login(page, email, PASSWORD);
    const key = `list-item-note-${Date.now()}`;
    const created = await page.request.post(`${BASE_URL}/api/notes`, {
      data: { key, value: "What this note says, readable under its key.", tags: ["alpha"] },
    });
    expect(created.ok()).toBe(true);

    const note = await openListView(page, "/notes", `[data-testid="note-row-${key}"]`);
    await expectSlottedItem(note);
    await expect(note.locator('[data-slot="card-description"]')).toContainText(
      "What this note says",
    );
    await expect(note.locator('[data-slot="card-meta"]').getByTestId("tag-alpha")).toBeVisible();

    await note.locator('[data-slot="card-title"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
  });

  test("a page fills the list's box in both views, and a view switch starts again from page 1", async ({
    page,
  }) => {
    // A tall window: the box holds many rows, so a page sized by the typical item height instead of
    // the drawn one leaves a visible empty band
    await page.setViewportSize({ width: 1440, height: 1400 });
    const email = `list-items-fill-${Date.now()}@example.com`;
    expect((await createTestUser(email, PASSWORD, "List Fill")).success).toBe(true);
    await login(page, email, PASSWORD);
    // More short notes than any page holds, so the page size, not the data, bounds what is shown
    for (let i = 0; i < 30; i++) {
      const created = await page.request.post(`${BASE_URL}/api/notes`, {
        data: { key: `fill-${String(i).padStart(2, "0")}`, value: "short" },
      });
      expect(created.ok()).toBe(true);
    }

    await openListView(page, "/notes", '[data-testid^="note-row-"]');
    const box = page.getByTestId("data-list-items");
    // The page settles once the drawn items are measured. In the list view a page is the items
    // that fit; in the grid view it is the rows that fit times the columns (three at this width).
    const layout = () =>
      box.evaluate((node) => {
        const items = Array.from(node.querySelectorAll<HTMLElement>('[data-slotted="true"]'));
        const rects = items.map((item) => item.getBoundingClientRect());
        const last = rects[rects.length - 1];
        return {
          count: items.length,
          columns: new Set(rects.map((rect) => Math.round(rect.left))).size,
          room: node.getBoundingClientRect().bottom - last.bottom,
          height: last.height,
        };
      });
    const fills = async (gap: number) => {
      const { room, height } = await layout();
      return room >= 0 && room < height + gap;
    };
    await expect.poll(() => fills(8)).toBe(true);

    // On page 2 of the list view, switching to the grid changes the page size and starts again
    // from page 1, so no item is skipped
    await page.getByTestId("pagination-next").click();
    await expect(page.getByTestId("pagination-prev")).toBeEnabled();
    await page.getByTestId("view-mode-grid").click();
    await expect(page.getByTestId("pagination-prev")).toBeDisabled();
    await expect.poll(() => fills(12)).toBe(true);
    const grid = await layout();
    expect(grid.columns).toBe(3);
    expect(grid.count % 3).toBe(0);
    expect(grid.count).toBeGreaterThanOrEqual(6);
  });

  test("paging stays on the page the reader chose when its items differ in height from page 1's", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const email = `list-items-paging-${Date.now()}@example.com`;
    expect((await createTestUser(email, PASSWORD, "List Paging")).success).toBe(true);
    await login(page, email, PASSWORD);
    // Older flows describe themselves over two lines; the newest, listed first, has no
    // description and draw shorter
    const long =
      "A flow whose description runs long enough to fill the two lines a list item shows, so its " +
      "item is taller than one without a description at all, which is what this check needs.";
    for (let i = 0; i < 28; i++) {
      const created = await page.request.post(`${BASE_URL}/api/workflows`, {
        data: {
          visibility: "private",
          workflow: {
            metadata: {
              name: `Paging ${String(i).padStart(2, "0")}`,
              version: "1.0.0",
              ...(i < 27 ? { description: long } : {}),
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        },
      });
      expect(created.ok()).toBe(true);
    }

    await page.goto(`${BASE_URL}/workflows`);
    await page.getByTestId("workflow-scope-mine").click();
    await page.getByTestId("view-mode-list").click();
    await expect(page.locator('[data-testid="workflow-card"]').first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    const requests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workflows" && url.searchParams.get("access") === "mine") {
        requests.push(`${url.searchParams.get("limit")}@${url.searchParams.get("offset")}`);
      }
    });
    await page.getByTestId("pagination-next").click();
    await page.waitForLoadState("networkidle");
    // Let a measurement of the new page's items take effect if it were going to
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForLoadState("networkidle");

    // One request for page 2, and the reader is still on it
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toMatch(/@0$/);
    await expect(page.getByTestId("pagination-prev")).toBeEnabled();
    await expect(
      page.locator('[data-testid="workflow-card"] [data-slot="card-description"]').first(),
    ).toContainText("A flow whose description");
  });

  test("an artifact is a slotted item: name, owner-side facts on the meta line, actions with hints", async ({
    page,
  }) => {
    const email = `list-items-artifact-${Date.now()}@example.com`;
    expect((await createTestUser(email, PASSWORD, "List Artifacts", true)).success).toBe(true);
    await login(page, email, PASSWORD);
    const name = `List item artifact ${Date.now()}`;
    const created = await page.request.post(`${BASE_URL}/api/artifacts`, {
      data: { name, content: "<!DOCTYPE html><html><body>list item</body></html>" },
    });
    expect(created.status()).toBe(201);
    const { uuid } = ((await created.json()) as { data: { uuid: string } }).data;

    const artifact = await openListView(page, "/artifacts", `[data-testid="artifact-row-${uuid}"]`);
    await expectSlottedItem(artifact);
    await expect(artifact.locator('[data-slot="card-title"]')).toHaveText(name);
    await expect(artifact.getByTestId(`delete-${uuid}`)).toHaveAttribute("data-hint", /.+/);
  });

  test.describe("administrator lists", () => {
    test.beforeEach(async ({ page }) => {
      await loginAsAdmin(page);
    });

    test("an execution is a slotted item with a translated status; Enter on its title opens the run", async ({
      page,
    }) => {
      const client = await createAuthenticatedMCPClient();
      try {
        await startWorkflowExecutionState(client.client, TEST_WORKFLOWS.REACT_FLOW_THEME.id);
      } finally {
        await client.cleanup();
      }
      const execution = await openListView(page, "/executions", '[data-testid="execution-card"]');
      await expectSlottedItem(execution);
      await expect(execution.locator("[data-status]")).toHaveText(
        /^(Running|Waiting for the agent|Waiting for you|Completed|Failed|Locked|Stopped)$/,
      );

      await execution.locator('[data-slot="card-title"]').focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}/);
    });

    test("a slower answer to an older page-size request does not replace the newer page", async ({
      page,
    }) => {
      // Switching views changes page size; the grid can issue more than one sizing request.
      // Hold every grid answer until the newer list has actually appeared in the browser.
      await page.setViewportSize({ width: 1440, height: 900 });
      await openListView(page, "/admin/audit-log", '[data-testid="audit-log-card"]');
      await page.waitForLoadState("networkidle");
      const stableListLimit = await page.getByTestId("audit-log-card").count();
      const limits: number[] = [];
      let phase: "grid" | "list" = "grid";
      let releaseHeld: () => void = () => undefined;
      const releaseOlder = new Promise<void>((resolve) => (releaseHeld = resolve));
      let markHeld: () => void = () => undefined;
      const requestHeld = new Promise<void>((resolve) => (markHeld = resolve));
      const olderCompleted: Promise<unknown>[] = [];
      let markNewer: () => void = () => undefined;
      const newerDelivered = new Promise<void>((resolve) => (markNewer = resolve));
      let newerTitles: string[] = [];
      await page.route("**/api/admin/audit-log?*", async (route) => {
        const requestPhase = phase;
        const limit = Number(new URL(route.request().url()).searchParams.get("limit"));
        limits.push(limit);
        const isOlder = requestPhase === "grid" || limit !== stableListLimit;
        if (isOlder) {
          const request = route.request();
          olderCompleted.push(
            page
              .waitForResponse((response) => response.request() === request)
              .then((response) => response.finished()),
          );
        }
        const response = await route.fetch();
        const body = await response.json();
        // Legal action strings identify accepted pages, even when their counts happen to match.
        const entries = body.data.entries.map(
          (entry: { id: string; action: string }, index: number) => ({
            ...entry,
            action: `${isOlder ? "older-grid" : "newer-list"}-${limit}-${index}`,
          }),
        );
        const json = { ...body, data: { ...body.data, entries } };
        if (isOlder) {
          markHeld();
          await releaseOlder;
          await route.fulfill({ response, json });
          return;
        }
        newerTitles = entries.map((entry: { action: string }) => entry.action);
        await route.fulfill({ response, json });
        markNewer();
      });

      await page.getByTestId("view-mode-grid").click();
      await requestHeld;
      phase = "list";
      await page.getByTestId("view-mode-list").click();
      await newerDelivered;
      const titles = page.getByTestId("audit-log-card").locator('[data-slot="card-title"]');
      await expect(titles).toHaveText(newerTitles);
      const acceptedNewerTitles = await titles.allTextContents();
      expect(acceptedNewerTitles).toHaveLength(stableListLimit);
      expect(olderCompleted.length).toBeGreaterThanOrEqual(1);
      expect(acceptedNewerTitles.every((title) => title.startsWith("newer-list-"))).toBe(true);
      // Only now can an older page arrive: fulfilment alone never proves React accepted a page.
      releaseHeld();
      expect(await Promise.all(olderCompleted)).toEqual(olderCompleted.map(() => null));
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      expect(limits.length).toBeGreaterThanOrEqual(2);
      expect(limits[0]).not.toBe(limits[limits.length - 1]);
      // Read once, not retried: the older page must not have replaced the newer one
      expect(await titles.allTextContents()).toEqual(acceptedNewerTitles);
      expect(await page.getByTestId("audit-log-card").count()).toBe(acceptedNewerTitles.length);
    });

    for (const { path, item } of [
      { path: "/admin/users", item: '[data-testid="user-card"]' },
      { path: "/admin/audit-log", item: '[data-testid="audit-log-card"]' },
      { path: "/admin/workflows", item: '[data-testid="admin-workflow-card"]' },
    ]) {
      test(`${path} draws its items as slotted items`, async ({ page }) => {
        await expectSlottedItem(await openListView(page, path, item));
      });
    }
  });
});
