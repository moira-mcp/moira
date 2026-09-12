/**
 * Step cards and the run panel strip: on the flow page's split view and on the run page's block
 * panel every step is one card on one grid — the type badges share one box, the badges' and the
 * titles' left edges line up, the badge and the title start on the same line, and a card with
 * transition chips keeps its title's left edge; the run panel's tab strip never overflows
 * horizontally, at desktop width and on a phone, and its counters are badges; pass counts are
 * secondary text.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

type Box = { x: number; y: number; width: number; height: number };

async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

/** Every card of `list` shares the badge box, the badge x, the title x and the badge/title top. */
async function expectOneGrid(page: Page, list: string): Promise<number> {
  const badges = await boxes(page, `${list} [data-step-card] [data-step-badge]`);
  const titles = await boxes(page, `${list} [data-step-card] [data-step-title]`);
  expect(badges.length).toBeGreaterThan(1);
  expect(titles).toHaveLength(badges.length);
  const widths = new Set(badges.map((b) => Math.round(b.width)));
  const heights = new Set(badges.map((b) => Math.round(b.height)));
  expect(widths.size).toBe(1);
  expect(heights.size).toBe(1);
  expect(new Set(badges.map((b) => Math.round(b.x))).size).toBe(1);
  expect(new Set(titles.map((b) => Math.round(b.x))).size).toBe(1);
  for (let i = 0; i < badges.length; i += 1) {
    expect(Math.abs(badges[i].y - titles[i].y)).toBeLessThanOrEqual(2);
  }
  return badges.length;
}

test("the flow page's split view lays the steps of the densest SDF block on one grid", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/software-development-flow?view=split`);
  await expect(page.getByTestId("split-blocks")).toBeVisible();
  // Find the block with the most steps.
  const ids = await page
    .locator('[data-testid^="split-block-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid")!.replace("split-block-", "")),
    );
  let densest = { id: ids[0], count: 0 };
  for (const id of ids) {
    await page.getByTestId(`split-block-${id}`).click();
    await expect(page.getByTestId("split-implementation")).toHaveAttribute("data-block-id", id);
    const count = await page.locator('[data-testid="split-nodes"] [data-node-id]').count();
    if (count > densest.count) densest = { id, count };
  }
  await page.getByTestId(`split-block-${densest.id}`).click();
  await expect(page.locator('[data-testid="split-nodes"] [data-node-id]')).toHaveCount(
    densest.count,
  );
  const cards = await expectOneGrid(page, '[data-testid="split-nodes"]');
  expect(cards).toBe(densest.count);
  // A card with transition chips keeps its title's left edge (chips wrap inside the body).
  const withChips = page.locator(
    '[data-testid="split-nodes"] [data-step-card]:has([data-step-connections])',
  );
  expect(await withChips.count()).toBeGreaterThan(0);
  const chipTitleX = (
    await boxes(
      page,
      '[data-testid="split-nodes"] [data-step-card]:has([data-step-connections]) [data-step-title]',
    )
  ).map((b) => Math.round(b.x));
  const anyTitleX = (await boxes(page, '[data-testid="split-nodes"] [data-step-title]')).map((b) =>
    Math.round(b.x),
  );
  expect(new Set([...chipTitleX, ...anyTitleX]).size).toBe(1);
  // External chips lead to another block.
  await expect(
    page.locator('[data-testid="split-nodes"] [data-edge-kind="external"]').first(),
  ).toBeVisible();
});

test("the run page's block panel uses the same cards and its tab strip never scrolls sideways", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    await expect(page.getByTestId("block-detail")).toBeVisible();
    const stepList = '[data-testid="block-detail"] [data-testid="step-list"]';
    await expect(page.locator(`${stepList} [data-step-card]`).first()).toBeVisible();
    await expectOneGrid(page, stepList);
    // The current step is marked on its card.
    await expect(page.locator(`${stepList} [data-step-card][aria-current="step"]`)).toHaveCount(1);
    // The Steps tab lists the whole definition on the same cards, in process-block order (the
    // start node first), with the run's done marks and the current step marked once.
    await page.getByRole("tab", { name: /Steps|Шаги/ }).click();
    const stepsTab = '[data-testid="steps-list"]';
    await expect(page.locator(`${stepsTab} [data-step-card]`).first()).toBeVisible();
    await expectOneGrid(page, stepsTab);
    await expect(
      page.locator(`${stepsTab} [data-step-card]`).first().locator("[data-step-title]"),
    ).toHaveText(/start/);
    expect(
      await page.locator(`${stepsTab} [data-step-card] [data-step-done]`).count(),
    ).toBeGreaterThan(0);
    await expect(page.locator(`${stepsTab} [data-step-card][aria-current="step"]`)).toHaveCount(1);
    await page.getByRole("tab", { name: /Block|Блок/ }).click();
    // The strip fits its panel at desktop width and on a phone: no horizontal overflow, no scrollbar.
    const strip = page.getByTestId("run-panel-tabs");
    const overflow = async () => strip.evaluate((el) => el.scrollWidth - el.clientWidth);
    // Wrapped rows stay inside the strip and the strip stays above the panel content: the last
    // tab's bottom edge is inside the strip's box and the strip ends above the block heading.
    const contained = async () => {
      const stripBox = (await strip.boundingBox())!;
      const tabs = await boxes(page, '[data-testid="run-panel-tabs"] [role="tab"]');
      const heading = (await page.getByTestId("block-detail").boundingBox())!;
      for (const tab of tabs) {
        expect(tab.y + tab.height).toBeLessThanOrEqual(stripBox.y + stripBox.height + 1);
      }
      expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(heading.y + 1);
    };
    expect(await overflow()).toBeLessThanOrEqual(0);
    await contained();
    await expect(strip).toHaveCSS("overflow-x", /visible|clip/);
    await page.setViewportSize({ width: 400, height: 900 });
    await expect(strip).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await contained();
    await expect(page.getByRole("tab", { name: /Locks|Блокировки/ })).toBeVisible();
    // Tabs say what they hold.
    await expect(page.getByRole("tab", { name: /Errors|Ошибки/ })).toHaveAttribute("title", /.+/);
    // Pass counts are secondary text, not a badge in the status chip.
    await expect(page.locator('[data-testid="status-iterations"]')).toHaveCount(0);
  } finally {
    await authenticated.cleanup();
  }
});
