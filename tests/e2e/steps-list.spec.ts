/**
 * E2E: a large flow reads as a list in the steps view. The Software Development Flow — dozens of
 * steps, forks and returns — opens as numbered instruction cards top to bottom at normal size; a
 * fork's labelled choices link to the step they lead to and following one brings it into view; a
 * return says which step it goes back to; "variables as words" and its link parameter work as on
 * the drawn diagram; and the walkthrough's steps anchor lands on an instruction card.
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const SDF = `${BASE_URL}/workflows/moira/software-development-flow?view=steps&lang=en`;

test.describe("Steps view as a reading list", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("the first step reads at normal size; a choice links to its step; a return names its step", async ({
    page,
  }) => {
    await page.goto(SDF);
    const view = page.getByTestId("steps-view");
    await expect(view).toHaveAttribute("data-presentation", "list");
    // Not the drawn web: no diagram canvas, no zoom
    await expect(view.locator(".react-flow")).toHaveCount(0);
    await expect(page.getByTestId("toolbar-zoom-in")).toHaveCount(0);

    const first = page.locator('[data-testid="steps-card"][data-step-kind="instruction"]').first();
    await expect(first).toBeInViewport();
    await expect(first).toContainText("Step 1");
    const text = first.getByTestId("steps-card-text");
    // Normal size: the text is drawn at its layout size (a zoomed diagram draws it at 0.6 or less
    // of it; `offsetWidth` is rounded, hence the tolerance), and the card is a full reading column
    expect(
      await text.evaluate(
        (node: HTMLElement) => node.getBoundingClientRect().width / node.offsetWidth,
      ),
    ).toBeCloseTo(1, 2);
    expect(await first.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(600);

    // A fork: a labelled way on that leads forward to another card
    const choice = page
      .locator('[data-testid="steps-way-on"] li')
      .filter({ has: page.locator('[data-testid="steps-way"]:not([data-back])') })
      .first();
    const way = choice.getByTestId("steps-way");
    const target = await way.getAttribute("data-target");
    expect(target).toBeTruthy();
    // From the keyboard: the reader lands on the step, and focus goes with them
    await way.focus();
    await page.keyboard.press("Enter");
    const reached = page.locator(`[data-testid="steps-card"][data-node-id="${target}"]`);
    await expect(reached).toHaveAttribute("data-highlighted", "true");
    await expect(reached).toBeInViewport();
    await expect(reached).toBeFocused();

    // A return reads "back to step N" and leads to that numbered step
    const back = page.locator('[data-testid="steps-way"][data-back="true"]').first();
    await expect(back).toHaveText(/^back to step \d+$/);
    const number = (await back.textContent())!.match(/\d+$/)![0];
    const backTarget = page.locator(
      `[data-testid="steps-card"][data-node-id="${await back.getAttribute("data-target")}"]`,
    );
    await expect(backTarget).toContainText(`Step ${number}`);
  });

  test("a link to a step opens the list at that step, on load and in place", async ({ page }) => {
    await page.goto(SDF);
    const instructions = page.locator('[data-testid="steps-card"][data-step-kind="instruction"]');
    const [loaded, inPlace] = await Promise.all(
      [20, 30].map((n) => instructions.nth(n).getAttribute("data-node-id")),
    );

    // A fresh load of the link
    await page.goto("about:blank");
    await page.goto(`${SDF}#step-${loaded}`);
    const first = page.locator(`[data-testid="steps-card"][data-node-id="${loaded}"]`);
    await expect(first).toBeInViewport();
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("data-highlighted", "true");
    // Applied once: the hash is dropped so a later change does not pull the reader back
    await expect(page).not.toHaveURL(/#step-/);

    // The same link followed on the open page changes only the hash
    await page.evaluate((id) => (window.location.hash = `step-${id}`), inPlace);
    const second = page.locator(`[data-testid="steps-card"][data-node-id="${inPlace}"]`);
    await expect(second).toBeInViewport();
    await expect(second).toHaveAttribute("data-highlighted", "true");
    await expect(page).not.toHaveURL(/#step-/);
  });

  test("variables read as words on the list too, and the choice lives in the link", async ({
    page,
  }) => {
    await page.goto(SDF);
    const cards = page.locator('[data-testid="steps-list"] [data-testid="steps-card"]');
    const toggle = page.getByTestId("steps-inline-toggle");
    await expect(toggle).toHaveAttribute("data-inline", "on");
    await expect(cards.first()).toBeVisible();
    await expect(cards.filter({ hasText: "{{" })).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-inline", "off");
    await expect(page).toHaveURL(/inline=0/);
    expect(await cards.filter({ hasText: "{{" }).count()).toBeGreaterThan(0);
  });

  test("the walkthrough's steps anchor lands on an instruction card of the list", async ({
    page,
  }) => {
    await page.goto(`${SDF}&guide=1`);
    await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "intro");
    await page.getByTestId("walkthrough-next").click();
    await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "steps");
    const target = page.locator('[data-guide-target="steps"]');
    await expect(target).toHaveAttribute("data-step-kind", "instruction");
    await expect(target).toBeInViewport({ ratio: 0.5 });
    await expect(page.getByTestId("steps-view")).toHaveAttribute("data-presentation", "list");
  });
});
