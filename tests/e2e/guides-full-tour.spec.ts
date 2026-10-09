/**
 * E2E: the full tour — every main-app screen's tour, one after another — as a reader meets it.
 *
 * Started from "Show me around", it walks home, the overview, the flow list, the example flow, the runs list, the
 * reader's latest run (or, with no run yet, the runs list's first-run step), notes, playbooks,
 * artifacts and Settings, never an admin page; at every step the spotlight is on the element the
 * card explains. It waits for each screen's code and data. Leaving the tour's page pauses it, and
 * "Continue" picks it up where it stopped; Preferences' "Start the tour again" starts it over. One
 * whole walk runs in Russian.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { quickTaskWithRepairLoop } from "./helpers/quick-task.js";
import { freshReader } from "./helpers/guides.js";

const BASE_URL = getTestBaseUrl();

interface Visit {
  guide: string;
  step: string;
  path: string;
}

/**
 * The card's guide and step, or "none" while no card is shown — read in one go in the page, so a
 * card that goes between two reads (the last card of the tour) cannot leave a read waiting for it.
 */
async function cardAt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="guide-card"]');
    return card ? `${card.dataset.guideId}/${card.dataset.guideStep}` : "none";
  });
}

/**
 * Walk the open tour, card by card, until no guide is open or `until` says to stop before a card.
 * At every card the spotlight must be on the card's own anchor.
 */
async function walkTour(page: Page, until?: (visit: Visit) => boolean): Promise<Visit[]> {
  const card = page.getByTestId("guide-card");
  const visits: Visit[] = [];
  for (let moves = 0; moves < 150; moves += 1) {
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toHaveAttribute("data-guide-anchor", /.+/, { timeout: 20000 });
    const anchor = await card.getAttribute("data-guide-anchor");
    if (!anchor) throw new Error("The visible guide card has no anchor");
    await expect(page.getByTestId("guide-spotlight")).toHaveAttribute("data-guide-anchor", anchor, {
      timeout: 20000,
    });
    const visit: Visit = {
      guide: (await card.getAttribute("data-guide-id"))!,
      step: (await card.getAttribute("data-guide-step"))!,
      path: new URL(page.url()).pathname,
    };
    if (until?.(visit)) return visits;
    visits.push(visit);
    const last = (await page.getByTestId("guide-finish").count()) > 0;
    await page.getByTestId(last ? "guide-finish" : "guide-next").click();
    const before = `${visit.guide}/${visit.step}`;
    await expect.poll(() => cardAt(page), { timeout: 20000 }).not.toBe(before);
    // The tour is over when the last screen's last card is gone and no guide is in the URL.
    if (last && (await cardAt(page)) === "none" && !new URL(page.url()).searchParams.has("guide"))
      return visits;
  }
  throw new Error("the tour did not end");
}

/** The guides a walk went through, in order, each once. */
const guidesOf = (visits: Visit[]) =>
  visits.map((visit) => visit.guide).filter((guide, index, all) => all[index - 1] !== guide);

async function startFromMenu(page: Page): Promise<void> {
  await page.getByTestId("show-me-around").click();
  await page.getByTestId("show-me-around-full-tour").click();
  await expect(page).toHaveURL(/tour=full/);
}

for (const language of ["en", "ru"] as const) {
  test(`the full tour visits every toured screen in order, and no admin page (${language})`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    await freshReader(page, `full-tour-${language}`);
    await page.goto(`${BASE_URL}/?lang=${language}`);
    await startFromMenu(page);
    const card = page.getByTestId("guide-card");
    await expect(card).toContainText(
      language === "en" ? "Your agent does the work" : "Работу делает ваш агент",
    );
    const visits = await walkTour(page);
    expect(guidesOf(visits)).toEqual([
      "home",
      "overview",
      "flows",
      "flow",
      "runs",
      // A new reader has no run yet: the runs list hands over the prompt instead.
      "runs-empty",
      "notes",
      "playbooks",
      "artifacts",
      "settings",
    ]);
    expect(visits.some((visit) => visit.path.includes("/admin"))).toBe(false);
    // The flow page is the example of the reader's language, with its playbook reference.
    const flow = visits.filter((visit) => visit.guide === "flow");
    expect(flow[0].path).toBe(
      language === "en"
        ? "/workflows/moira/example-simple-steps"
        : "/workflows/moira/example-simple-steps-ru",
    );
    expect(flow.map((visit) => visit.step)).toContain("playbook");
    // The last screen is Settings; the tour ends there with no guide open.
    expect(visits.at(-1)).toMatchObject({ guide: "settings", path: "/settings" });
  });
}

test("the full tour opens the reader's latest run on the run page", async ({ page }) => {
  test.setTimeout(180000);
  const authenticated = await createAuthenticatedMCPClient();
  const run = await quickTaskWithRepairLoop(authenticated.client);
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // From the runs list's last step, the tour goes on to the latest run.
    await page.goto(`${BASE_URL}/executions?guide=runs&step=list&tour=full`);
    await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "list", {
      timeout: 20000,
    });
    await page.getByTestId("guide-finish").click();
    await expect(page).toHaveURL(new RegExp(`/executions/${run.processId}\\?.*guide=run`));
    // The address changes before the lazily loaded run page replaces the list and its last card.
    await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-id", "run", {
      timeout: 20000,
    });
    const visits = await walkTour(page, (visit) => visit.guide === "notes");
    expect(guidesOf(visits)).toEqual(["run"]);
    expect(visits.map((visit) => visit.step)).toEqual(
      expect.arrayContaining(["modes", "panel-tabs", "answer", "notifications", "route"]),
    );
  } finally {
    await authenticated.cleanup();
  }
});

test("leaving the tour's page pauses it, and Continue resumes the full tour", async ({ page }) => {
  test.setTimeout(120000);
  await freshReader(page, "full-tour-pause");
  await page.goto(`${BASE_URL}/`);
  await startFromMenu(page);
  // Walk to the flow list's second card, then leave for Notes through the sidebar.
  await walkTour(page, (visit) => visit.guide === "flows" && visit.step !== "intro");
  const at = await cardAt(page);
  await page.getByRole("link", { name: "Notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByTestId("guide-card")).toHaveCount(0);
  // "Continue" returns to the same card, still in the full tour.
  await page.getByTestId("show-me-around").click();
  await page.getByTestId("show-me-around-resume").click();
  await expect(page).toHaveURL(/\/workflows\?.*tour=full/);
  await expect.poll(() => cardAt(page), { timeout: 20000 }).toBe(at);
  // … and the tour goes on to the next screen after the flow list.
  const visits = await walkTour(page, (visit) => visit.guide === "flow");
  expect(guidesOf(visits)).toEqual(["flows"]);
  await expect(page).toHaveURL(/\/workflows\/moira\/example-simple-steps\?.*guide=flow/);
});

test("Preferences' Start the tour again starts the full tour from the home page", async ({
  page,
}) => {
  await freshReader(page, "full-tour-restart");
  await page.goto(`${BASE_URL}/settings`);
  await page.getByTestId("settings-nav-preferences").click();
  await page.getByTestId("preferences-guides-restart").click();
  await expect(page).toHaveURL(/\/\?.*guide=home.*tour=full|\/\?.*tour=full.*guide=home/);
  await expect(page.getByTestId("guide-card")).toHaveAttribute("data-guide-id", "home");
});
