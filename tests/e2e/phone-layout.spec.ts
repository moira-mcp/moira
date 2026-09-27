/**
 * The web app on a phone (390×844): text keeps a readable width and the beta notice does not
 * take the screen from the page.
 *
 * - The flow page header's description is not squeezed beside the fact chips: the chips move to
 *   their own line instead.
 * - The "recommended to start" note spans the card, not the half the header actions leave.
 * - The beta notice is one short line on a phone and the full notice from the `sm` width up.
 * - A flow opens on the steps view on a phone, where a canvas opens with its first card cut at the
 *   screen's edge; a `view` in the link still wins.
 */

import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const PHONE = { width: 390, height: 844 };

async function atPhoneWidth(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await loginAsAdmin(page);
}

test("the flow header's description keeps a readable width on a phone", async ({ page }) => {
  await atPhoneWidth(page);
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  const description = page.getByTestId("page-description");
  await expect(description).toBeVisible();
  const box = (await description.boundingBox())!;
  // Squeezed beside the chips it was a few characters wide; now it takes the header's width.
  expect(box.width).toBeGreaterThanOrEqual(PHONE.width * 0.7);
  await expect(page.getByTestId("flow-node-count")).toBeVisible();
});

test("the recommended note spans the card on a phone", async ({ page }) => {
  await atPhoneWidth(page);
  await page.goto(`${BASE_URL}/workflows`);
  const section = page.getByTestId("recommended-flows");
  await expect(section).toBeVisible();
  const note = page.getByTestId("agent-first-note");
  await expect(note).toBeVisible();
  const card = (await section.boundingBox())!;
  const text = (await note.boundingBox())!;
  // Beside the header actions the note had about half the card; below them it has all of it.
  expect(text.width).toBeGreaterThanOrEqual(card.width * 0.8);
});

test("the beta notice is one short line on a phone and the full notice on a wide screen", async ({
  page,
}) => {
  await atPhoneWidth(page);
  await page.goto(`${BASE_URL}/workflows`);
  const banner = page.getByTestId("beta-warning-banner");
  await expect(banner).toBeVisible();
  const phone = (await banner.boundingBox())!;
  // The full notice took about a fifth of the screen; the short line takes a small band.
  expect(phone.height).toBeLessThanOrEqual(PHONE.height * 0.08);
  const fullNotice = banner.getByText(/понимание|understanding/u);
  await expect(fullNotice).toBeHidden();

  const shortLine = banner.getByText(/возможны изменения|changes are possible/u);
  await expect(shortLine).toBeVisible();
  // The dismiss button is a full touch target on a phone.
  const dismiss = (await page.getByTestId("beta-warning-dismiss").boundingBox())!;
  expect(Math.min(dismiss.width, dismiss.height)).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(fullNotice).toBeVisible();
  await expect(shortLine).toBeHidden();
});

test("a flow opens on the steps view on a phone and on the map on a wide screen; a link's view still wins", async ({
  page,
}) => {
  await atPhoneWidth(page);
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "steps");
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=map`);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "map");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "map");
});

test("the steps view fills the phone screen down to the beta notice, with no empty band", async ({
  page,
}) => {
  await atPhoneWidth(page);
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", "steps");
  const steps = (await page.getByTestId("steps-view").boundingBox())!;
  const banner = (await page.getByTestId("beta-warning-banner").boundingBox())!;
  // In a fixed 60vh box the view stopped 70–120 px above the notice; now it reaches it.
  expect(banner.y - (steps.y + steps.height)).toBeLessThanOrEqual(4);
});
