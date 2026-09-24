/**
 * A newcomer's path through the app: the home page explains that the agent does the work and
 * picks or builds the flow, the flow list opens on the recommended flows — learning examples in the
 * reader's language, then the universal flows — with its filters folded until wanted, and a
 * learning example opens on the steps view: numbered instructions joined by arrows, the fork's
 * answers written on its edges. On a flow with variables, "variables as words" turns every
 * `{{name}}` into plain words, and the choice is kept in the link.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const STEPS = '[data-testid="steps-canvas"] [data-diagram-settled="true"]';

async function slugsOf(page: Page, group: string): Promise<string[]> {
  const cards = page.getByTestId(group).getByTestId("recommended-flow");
  await expect(cards.first()).toBeVisible({ timeout: 15000 });
  return cards.evaluateAll((elements) => elements.map((element) => element.dataset.slug ?? ""));
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the home page leads with the agent-first steps, then connection and recommendations", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/?lang=en`);
  const how = page.getByTestId("home-how-it-works");
  await expect(how).toBeVisible({ timeout: 15000 });
  await expect(how.getByTestId("home-steps").locator("li")).toHaveCount(3);
  await expect(how).toContainText("Workflow Management Flow");
  await expect(how.getByTestId("home-optional")).toContainText("None of it is required");
  await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeVisible();
  const recommended = page.getByTestId("recommended-flows");
  await expect(recommended.getByTestId("recommended-flow")).toHaveCount(6);
  // The home page shows the compact section: nothing to fold, no "when to pick" lines.
  await expect(recommended.getByTestId("recommended-toggle")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-recent-workflows")).toBeVisible();

  await page.goto(`${BASE_URL}/?lang=ru`);
  await expect(page.getByTestId("home-how-it-works")).toContainText("Агент сам выберет флоу");
  expect(await slugsOf(page, "recommended-examples")).toEqual([
    "example-simple-steps-ru",
    "example-one-choice-ru",
    "example-several-paths-ru",
  ]);
});

test("the flow list recommends where to start and keeps its filters optional", async ({ page }) => {
  await page.goto(`${BASE_URL}/workflows?lang=en`);
  const recommended = page.getByTestId("recommended-flows");
  await expect(recommended.getByTestId("agent-first-note")).toContainText(
    "Workflow Management Flow",
  );
  expect(await slugsOf(page, "recommended-examples")).toEqual([
    "example-simple-steps",
    "example-one-choice",
    "example-several-paths",
  ]);
  expect(await slugsOf(page, "recommended-universal")).toEqual([
    "quick-task",
    "robust-task",
    "todo-list",
  ]);
  await expect(page.getByTestId("recommended-universal")).toContainText("Pick it when");

  // The section folds, and the fold is remembered across a reload.
  await recommended.getByTestId("recommended-toggle").click();
  await expect(recommended).toHaveAttribute("data-state", "closed");
  await page.reload();
  await expect(page.getByTestId("recommended-flows")).toHaveAttribute("data-state", "closed");
  await page.getByTestId("recommended-toggle").click();
  await expect(page.getByTestId("recommended-flows")).toHaveAttribute("data-state", "open");

  // Search is always there; status, visibility and sort wait behind "Filters".
  const explorer = page.getByTestId("workflow-explorer");
  await expect(explorer.getByPlaceholder(/search/i)).toBeVisible();
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await page.getByTestId("filters-toggle").click();
  await page.getByTestId("visibility-filter").click();
  await page.getByRole("option", { name: "Private" }).click();
  // A filter in effect keeps the controls open and is counted on the button.
  await expect(page.getByTestId("filters-toggle")).toContainText("1");
  await page.getByTestId("filter-reset").click();
  await expect(page.getByTestId("filters-toggle")).not.toContainText("1");

  await page
    .getByTestId("recommended-examples")
    .locator('[data-slug="example-one-choice"]')
    .click();
  await expect(page).toHaveURL(/\/workflows\/moira\/example-one-choice$/);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "steps");
});

test("a learning example reads as numbered instructions with its fork labelled on the edges", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/workflows/moira/example-one-choice?lang=en`);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "steps");
  await expect(page.locator(STEPS)).toBeVisible({ timeout: 20000 });

  const canvas = page.getByTestId("steps-canvas");
  const cards = canvas.getByTestId("steps-card");
  await expect(cards.and(page.locator('[data-step-kind="instruction"]'))).toHaveCount(4);
  await expect(cards.and(page.locator('[data-step-kind="finish"]'))).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute("data-step-kind", "start");
  await expect(canvas.locator('[data-node-id="do-task"]')).toContainText(
    "Do the task the user asked for.",
  );
  // A diagram, not a list: every connection of the flow is an edge, and only the fork's two ways
  // out carry a label — the answers the agent can give.
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(6);
  await expect(canvas.locator(".react-flow__edge-text")).toHaveText([
    "yes — it matches",
    "no — something is missing",
  ]);

  // The same flow in Russian reads in Russian.
  await page.goto(`${BASE_URL}/workflows/moira/example-one-choice-ru?lang=ru`);
  await expect(page.locator(STEPS)).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("steps-canvas").locator(".react-flow__edge-text")).toHaveText([
    "да — совпадает",
    "нет — чего-то не хватает",
  ]);

  // The map and the graph are one click away.
  await page.getByTestId("flow-modes").locator('[data-mode="map"]').click();
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("map-contents-list").locator("[data-block-id]")).toHaveCount(4);
});

test("variables read as plain words on the steps view, and the choice lives in the link", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/workflows/moira/todo-list?view=steps&lang=en`);
  await expect(page.locator(STEPS)).toBeVisible({ timeout: 20000 });
  const canvas = page.getByTestId("steps-canvas");
  const toggle = page.getByTestId("steps-inline-toggle");

  // On by default: no template syntax in any card, the references are words.
  await expect(toggle).toHaveAttribute("data-inline", "on");
  await expect(canvas.locator("[data-variable-inline]").first()).toBeVisible();
  await expect(canvas.locator("[data-variable]")).toHaveCount(0);
  await expect(canvas.getByTestId("steps-card").filter({ hasText: "{{" })).toHaveCount(0);

  await toggle.click();
  await expect(page).toHaveURL(/inline=0/);
  await expect(toggle).toHaveAttribute("data-inline", "off");
  await expect(canvas.locator("[data-variable]").first()).toContainText("{{");
  await expect(canvas.locator("[data-variable-inline]")).toHaveCount(0);

  // The link carries the choice to another reader.
  await page.goto(`${BASE_URL}/workflows/moira/todo-list?view=steps&inline=0&lang=en`);
  await expect(page.getByTestId("steps-inline-toggle")).toHaveAttribute("data-inline", "off");
});
