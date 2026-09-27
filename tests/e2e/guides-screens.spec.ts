/**
 * E2E: the screen tours of the home page, the flow list, the runs list, notes, playbooks and
 * artifacts, as a new reader meets them.
 *
 * Each tour is opened with its page's "What is this?" and walked to its end. At every step the card
 * names the step, the spotlight lands on the element the step explains, and that element is on
 * screen. A new account has every beginner panel shown, so the walk meets every step whose element
 * exists; with the panels hidden, the steps about them are skipped rather than waited for. The
 * playbooks tour opened from a flow's link to someone else's playbook reaches the read-only view.
 * One walk runs in Russian. On a phone, the home tour's step on "Show me around" opens the sidebar
 * sheet with the card reachable in it, and the sheet closes again when the tour moves on.
 *
 * Every test signs in as a fresh user, with the first-run question already answered, so no prompt
 * covers the page and no other spec's data changes what a tour meets.
 */

import { test, expect, type Page } from "./fixtures.js";
import { freshReader } from "./helpers/guides.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
/** The step ids a tour runs through and the anchor each one explains. */
type Walk = readonly (readonly [step: string, anchor: string])[];

/**
 * Walk the open tour to its end: at every step the card names the step, and the spotlight and the
 * element it explains are the step's anchor, on screen. `lastSkipped`: the tour has one more,
 * optional step whose element is absent, so moving on from the last listed step ends the tour.
 */
async function walk(page: Page, guideId: string, steps: Walk, lastSkipped = false): Promise<void> {
  const card = page.getByTestId("guide-card");
  for (const [index, [id, anchor]] of steps.entries()) {
    await expect(card).toHaveAttribute("data-guide-id", guideId);
    await expect(card).toHaveAttribute("data-guide-step", id, { timeout: 15000 });
    await expect(card).toHaveAttribute("data-guide-anchor", anchor);
    await expect(page.getByTestId("guide-spotlight")).toHaveAttribute("data-guide-anchor", anchor, {
      timeout: 15000,
    });
    const target = page.locator(`[data-guide~="${anchor}"]:visible`).first();
    await expect(target).toBeInViewport({ ratio: 0.5, timeout: 15000 });
    if (index < steps.length - 1) await page.getByTestId("guide-next").click();
  }
  await page.getByTestId(lastSkipped ? "guide-next" : "guide-finish").click();
  await expect(card).toHaveCount(0, { timeout: 15000 });
  // No other step was ever shown on the way, not even for a moment before being skipped.
  expect(await cardSteps(page)).toEqual(steps.map(([id]) => id));
}

/**
 * A private flow of the reader's, tagged with the level the Workflow Management Flow records. The
 * bundled flows carry no level, so without it the list may show no level badge to explain; the
 * newest flow comes first, so this one is on the first page.
 */
async function leveledFlow(page: Page): Promise<void> {
  const created = await page.request.post(`${BASE_URL}/api/workflows`, {
    headers: { Origin: new URL(BASE_URL).origin },
    data: {
      visibility: "private",
      workflow: {
        metadata: {
          name: `Leveled flow ${Date.now()}`,
          version: "1.0.0",
          description: "A flow built at the simple level.",
          tags: ["complexity:simple"],
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

/**
 * Keep, in the page, every step id the guide card ever shows, in order: a step that appears for a
 * moment and is then skipped is caught, which waiting for the next expected step cannot tell apart.
 */
async function recordCardSteps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shown: string[] = [];
    (window as unknown as { guideCardSteps: string[] }).guideCardSteps = shown;
    new MutationObserver(() => {
      const step = document
        .querySelector('[data-testid="guide-card"]')
        ?.getAttribute("data-guide-step");
      if (step && shown[shown.length - 1] !== step) shown.push(step);
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

const cardSteps = (page: Page) =>
  page.evaluate(() => (window as unknown as { guideCardSteps: string[] }).guideCardSteps);

/** Open a page and its tour with "What is this?", checking the button offers that page's tour. */
async function openTour(page: Page, path: string, guideId: string): Promise<void> {
  await page.goto(`${BASE_URL}${path}`);
  await recordCardSteps(page);
  const open = page.getByTestId("guide-open");
  await expect(open).toHaveAttribute("data-guide-id", guideId, { timeout: 20000 });
  await open.click();
  await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-id", guideId);
}

const TOURS: readonly (readonly [
  guide: string,
  path: string,
  shown: Walk,
  hidden: Walk,
  hiddenLastSkipped?: boolean,
])[] = [
  [
    "home",
    "/",
    [
      ["intro", "home.header"],
      ["how", "home.how-it-works"],
      ["connect", "home.connect"],
      ["try", "home.try"],
      ["recommended", "home.recommended"],
      ["work", "home.work"],
      ["show-me-around", "home.show-me-around"],
    ],
    [
      ["intro", "home.header"],
      ["work", "home.work"],
      ["show-me-around", "home.show-me-around"],
    ],
  ],
  [
    "flows",
    "/workflows",
    [
      ["intro", "flows.header"],
      ["recommended", "flows.recommended"],
      ["all", "flows.list"],
      ["scopes", "flows.scopes"],
      ["filters", "flows.filters"],
      ["level", "flows.level"],
    ],
    // No flow on the list has a level here (see below), so the level step is skipped too.
    [
      ["intro", "flows.header"],
      ["all", "flows.list"],
      ["scopes", "flows.scopes"],
      ["filters", "flows.filters"],
    ],
    true,
  ],
  [
    "runs",
    "/executions",
    [
      ["intro", "runs.header"],
      ["status", "runs.status"],
      ["list", "runs.list"],
    ],
    [],
  ],
  [
    "notes",
    "/notes",
    [
      ["intro", "notes.header"],
      ["create", "notes.create"],
      ["list", "notes.list"],
      ["quota", "notes.quota"],
    ],
    [],
  ],
  [
    "playbooks",
    "/playbooks",
    [
      ["intro", "playbooks.header"],
      ["create", "playbooks.create"],
      ["list", "playbooks.list"],
    ],
    [],
  ],
  [
    "artifacts",
    "/artifacts",
    [
      ["intro", "artifacts.header"],
      ["quota", "artifacts.quota"],
      ["create", "artifacts.create"],
      ["list", "artifacts.list"],
    ],
    [],
  ],
];

test.describe("Screen tours", () => {
  for (const [guide, path, shown, hidden, hiddenLastSkipped] of TOURS) {
    test(`the ${guide} tour lands on what each step explains`, async ({ page }) => {
      await freshReader(page, guide);
      if (guide === "flows") await leveledFlow(page);
      await openTour(page, path, guide);
      await walk(page, guide, shown);
    });

    // Only the home page and the flow list have beginner panels.
    if (hidden.length > 0) {
      test(`the ${guide} tour skips the steps about hidden beginner panels`, async ({ page }) => {
        await freshReader(page, `${guide}-hidden`, true);
        await openTour(page, path, guide);
        await walk(page, guide, hidden, hiddenLastSkipped);
      });
    }
  }

  test("with the beginner panels hidden, the home tour passes its four panel steps at once and says so", async ({
    page,
  }) => {
    await freshReader(page, "hidden-note", true);
    await openTour(page, "/", "home");
    await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "intro");
    const moved = Date.now();
    await page.getByTestId("guide-next").click();
    await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "work");
    // The panels are known to be hidden: no step waits the runner's three seconds for them.
    expect(Date.now() - moved).toBeLessThan(2000);
    await expect(page.getByTestId("guide-note")).toHaveText(
      "4 steps were skipped: what they explain is not on this page right now.",
    );
  });

  test("the browser's Back crosses the steps a tour passed without showing, back to the start and out of the tour", async ({
    page,
  }) => {
    await freshReader(page, "history", true);
    await openTour(page, "/", "home");
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "intro");
    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "work");
    await expect(page.getByTestId("guide-note")).toContainText("4 steps were skipped");
    await page.goBack();
    await expect(card).toHaveAttribute("data-guide-step", "intro");
    // Nothing was skipped on the way back to the first step: the note stayed with "Your work".
    await expect(page.getByTestId("guide-note")).toHaveCount(0);
    await page.goBack();
    await expect(card).toHaveCount(0);
    await expect(page).not.toHaveURL(/guide=/);
  });

  // The link a flow's step draws for `{{playbook:@moira/clear-report}}` (Example 1's report step).
  test("the playbooks tour opened from a link to someone else's playbook explains the read-only view", async ({
    page,
  }) => {
    await freshReader(page, "linked");
    await openTour(page, "/playbooks?name=clear-report&owner=%40moira", "playbooks");
    await expect(page.getByTestId("linked-playbook")).toBeVisible();
    await walk(page, "playbooks", [
      ["intro", "playbooks.header"],
      ["linked", "playbooks.linked"],
      ["create", "playbooks.create"],
      ["list", "playbooks.list"],
    ]);
  });

  test("the home tour speaks Russian", async ({ page }) => {
    await freshReader(page, "ru");
    // `?lang=ru` is the querystring the app's language detector reads first.
    await openTour(page, "/?lang=ru", "home");
    const card = page.getByTestId("guide-card");
    await expect(card).toContainText("Работу делает ваш агент");
    await expect(card.getByTestId("guide-next")).toHaveText(/Дальше/);
    // The whole tour runs, and lands where it does in English.
    await walk(page, "home", TOURS[0][2]);
  });

  test("on a phone, the step on Show me around opens the sidebar sheet and the next move closes it", async ({
    page,
  }) => {
    await freshReader(page, "phone");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/?guide=home&step=work`);
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "work", { timeout: 20000 });
    const sheet = page.locator('[data-mobile="true"]');
    await expect(sheet).toHaveCount(0);

    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "show-me-around");
    await expect(sheet).toBeVisible();
    const target = sheet.locator('[data-guide~="home.show-me-around"]');
    await expect(target).toBeInViewport();
    await expect(page.getByTestId("guide-spotlight")).toHaveAttribute(
      "data-guide-anchor",
      "home.show-me-around",
    );
    // The card sits where the reader can reach it, and its buttons take a press over the sheet.
    await expect(card).toBeInViewport();
    await page.getByTestId("guide-back").click();
    await expect(card).toHaveAttribute("data-guide-step", "work");
    await expect(sheet).toHaveCount(0);

    await page.getByTestId("guide-next").click();
    await expect(sheet).toBeVisible();
    await page.getByTestId("guide-finish").click();
    await expect(card).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  });
});
