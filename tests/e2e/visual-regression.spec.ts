/**
 * Visual Regression Tests
 *
 * Screenshots of the principal pages in the light and the dark theme, compared with committed
 * baselines.
 *
 * - The theme is chosen through the storage key the application reads (`theme`, see `useTheme`).
 * - The application scrolls inside `main#main-content`, not the page, so a page screenshot would
 *   only show the first screen. The viewport is grown to the height of the scrolled content
 *   instead, which renders all of it without touching the application's styles.
 * - The tolerance is tight: a hundred pixels, so even a small change to a heading fails. Content
 *   that legitimately differs between runs (counts, names, dates, lists other tests fill) is
 *   masked at a fixed size.
 */

import { test, expect, type Locator, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const WIDTH = 1280;
const MIN_HEIGHT = 720;
/** The fixed capture height of a page whose length depends on data. */
const DATA_PAGE_HEIGHT = 1600;
/**
 * An absolute pixel budget, not a ratio: on a page thousands of pixels tall a ratio small enough to
 * notice one step up in the section headings' type size would still depend on the page's length.
 * Volatile regions are masked at a fixed size, so runs differ by rendering noise only, which stays
 * far below this; the Settings redesign changed hundreds of thousands of pixels.
 */
const MAX_DIFF_PIXELS = 100;

interface VisualPage {
  name: string;
  path: string;
  waitFor: string;
  requiresAuth?: false;
  /**
   * Capture everything `main` scrolls through. Only for a page whose length does not depend on
   * data (Settings pages its lists); a data page is captured at a fixed tall height instead, so a
   * longer list does not change the image size.
   */
  fullContent?: true;
  /** Regions whose content depends on data other tests create, not on the page's design. */
  volatile?: (page: Page) => Locator[];
  /**
   * CSS added to the page before the screenshot: gives a volatile region a fixed height, so a
   * longer or shorter list moves nothing around its mask.
   */
  captureStyle?: string;
  /** Capture only down to the bottom of this element: everything below it is live data. */
  clipBelow?: (page: Page) => Locator;
}

/** Every page: the signed-in user's name and email in the sidebar change between runs. */
const sidebarUser = (page: Page) => [page.locator('[data-sidebar="footer"]')];

/** A data list: its rows come from whatever other tests created. */
const dataList = (page: Page) => [page.getByTestId("data-list-items")];
/**
 * The list area at a fixed height whether it shows rows or an empty state, and the pagination,
 * which exists only when there are rows, left out of the capture.
 */
const DATA_LIST_STYLE = `
  [data-testid="data-list-items"] { height: 900px !important; overflow: hidden !important; }
  [data-testid="data-list-pagination"] { display: none !important; }`;

const PAGES: VisualPage[] = [
  {
    name: "dashboard",
    path: "/",
    waitFor: '[data-testid="work-area"]',
    // The beginner panels are left out of the capture so the work area is in it. The area lists the
    // admin's own runs and flows, which other tests keep changing: its heading is compared, its
    // content gets a fixed height and is masked.
    volatile: (page) => [page.getByTestId("work-area").locator(":scope > :last-child")],
    captureStyle: `
      [data-testid="home-how-it-works"], [data-testid="quick-start-card"],
      [data-testid="recommended-flows"] { display: none !important; }
      [data-testid="work-area"] > :last-child {
        height: 520px !important; overflow: hidden !important; }`,
  },
  {
    name: "workflows",
    path: "/workflows",
    waitFor: '[data-testid="workflow-card"]',
    volatile: dataList,
    captureStyle: DATA_LIST_STYLE,
  },
  {
    name: "executions",
    path: "/executions",
    waitFor: "main",
    volatile: dataList,
    captureStyle: DATA_LIST_STYLE,
  },
  {
    name: "notes",
    path: "/notes",
    waitFor: "main",
    volatile: dataList,
    captureStyle: DATA_LIST_STYLE,
  },
  {
    name: "artifacts",
    path: "/artifacts",
    waitFor: "main",
    volatile: dataList,
    captureStyle: DATA_LIST_STYLE,
  },
  {
    name: "settings",
    path: "/settings",
    waitFor: '[data-testid="settings-flat-layout"]',
    fullContent: true,
    // The admin's own data and the shared state other tests leave behind: the signed-in devices,
    // the Telegram configuration, connected apps and API tokens get a fixed height and are masked,
    // and the extension-defined settings other tests create are left out, together with the
    // spacing the card before them keeps while they exist (it would lengthen the page); the
    // headings and the rest of the page stay compared whatever the database holds.
    volatile: (page) => [
      page.getByTestId("profile-name-input"),
      page.getByTestId("settings-section-sessions").locator(":scope > :last-child"),
      page.locator('[data-settings-section="notifications"] > :last-child'),
      page.locator('[data-settings-section="connected-apps"] > :last-child'),
      page.locator('[data-settings-section="api-tokens"] > :last-child'),
    ],
    captureStyle: `
      [data-testid="settings-section-sessions"] > :last-child,
      [data-settings-section="connected-apps"] > :last-child,
      [data-settings-section="api-tokens"] > :last-child {
        height: 360px !important; overflow: hidden !important; }
      [data-settings-section="notifications"] > :last-child {
        height: 640px !important; overflow: hidden !important; }
      [data-testid="settings-section-other"] { display: none !important; }
      :has(+ [data-testid="settings-section-other"]) { margin-block-end: 0 !important; }`,
  },
  {
    name: "admin-dashboard",
    path: "/admin",
    waitFor: "main",
    // Below the system health row the page is live analytics (charts, top workflows and users,
    // recent activity) whose height follows the data; the capture stops above it.
    clipBelow: (page) => page.getByTestId("admin-system-health"),
    volatile: (page) => [
      page.getByTestId("stat-card"),
      page.getByTestId("admin-system-health").getByText(/^[\d.]+\s?(B|KB|MB|GB)$/),
    ],
  },
  {
    name: "audit-log",
    path: "/admin/audit-log",
    waitFor: "main",
    volatile: dataList,
    captureStyle: DATA_LIST_STYLE,
  },
  { name: "login", path: "/login", waitFor: "form", requiresAuth: false },
];

/** The height of everything `main` scrolls through, measured in page coordinates. */
async function contentHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main#main-content");
    if (!main) return document.documentElement.scrollHeight;
    return Math.ceil(main.getBoundingClientRect().top + main.scrollHeight);
  });
}

/**
 * Wait until the page has stopped growing: sections that load their own data would otherwise be
 * missing, cut off or placed higher in whichever run measured first. Returns the settled height.
 */
async function settledContentHeight(page: Page): Promise<number> {
  await page.waitForLoadState("networkidle");
  let previous = -1;
  await expect
    .poll(
      async () => {
        const height = await contentHeight(page);
        const settled = height === previous;
        previous = height;
        return settled;
      },
      { intervals: [300], timeout: 15_000 },
    )
    .toBe(true);
  return previous;
}

/** Grow the viewport to the scrolled content of `main`, so one screenshot shows all of it. */
async function showAllContent(page: Page, height: number): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: Math.max(MIN_HEIGHT, height) });
  // Once all of it is in view, content that lays out lazily may still add height.
  const grown = await contentHeight(page);
  if (grown > height) await page.setViewportSize({ width: WIDTH, height: grown });
}

test.describe("Visual Regression Screenshots", () => {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} mode`, () => {
      for (const visual of PAGES) {
        test(`${visual.name} - ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: WIDTH, height: MIN_HEIGHT });
          if (visual.requiresAuth !== false) {
            await loginAsAdmin(page);
          }

          await page.addInitScript((value) => {
            localStorage.setItem("theme", value);
          }, theme);

          await page.goto(`${BASE_URL}${visual.path}?lang=en`);
          await expect(page.locator(visual.waitFor).first()).toBeVisible({ timeout: 15000 });
          await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
          await page.evaluate(() => document.fonts.ready);
          if (visual.captureStyle) await page.addStyleTag({ content: visual.captureStyle });
          if (visual.requiresAuth !== false && !visual.fullContent) {
            await page.setViewportSize({ width: WIDTH, height: DATA_PAGE_HEIGHT });
          }
          const height = await settledContentHeight(page);
          if (visual.fullContent) await showAllContent(page, height);

          const clipTo = visual.clipBelow ? await visual.clipBelow(page).boundingBox() : null;
          await expect(page).toHaveScreenshot(`${visual.name}-${theme}.png`, {
            maxDiffPixels: MAX_DIFF_PIXELS,
            ...(clipTo
              ? { clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(clipTo.y + clipTo.height) } }
              : {}),
            animations: "disabled",
            caret: "hide",
            mask: [
              ...(visual.requiresAuth !== false ? sidebarUser(page) : []),
              ...(visual.volatile?.(page) ?? []),
            ],
          });
        });
      }
    });
  }
});
