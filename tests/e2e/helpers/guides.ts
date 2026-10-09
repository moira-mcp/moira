/**
 * Setup the guide E2E specs share: a fresh account, signed in, with the first-run question already
 * answered (so no prompt covers the page) and the beginner panels shown or hidden as asked.
 */

import { expect, type Page } from "@playwright/test";
import { createTestUser, login } from "./auth-helper.js";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";
const BEGINNER_PANELS = ["home-intro", "quick-start", "home-recommended", "workflows-recommended"];

/** Read the card, spotlight and first visible anchor together, including native viewport clipping. */
export async function expectGuideStep(page: Page, guideId: string, stepId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const card = document.querySelector('[data-testid="guide-card"]');
          const anchor = card?.getAttribute("data-guide-anchor");
          const visible = (element: Element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse"
            );
          };
          const firstVisible = () =>
            anchor
              ? [...document.querySelectorAll("[data-guide]")].find(
                  (element) =>
                    element.getAttribute("data-guide")?.split(/\s+/).includes(anchor) &&
                    visible(element),
                )
              : undefined;
          const target = firstVisible();
          if (!card || !anchor || !target) return null;
          return new Promise((resolve) => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect();
              const box = target.getBoundingClientRect();
              const node = target.closest(".react-flow__node");
              const pane = node?.closest(".react-flow");
              const frame = pane?.getBoundingClientRect();
              resolve({
                guideId: card.getAttribute("data-guide-id"),
                stepId: card.getAttribute("data-guide-step"),
                anchored: anchor.length > 0 && card.getAttribute("data-guide-anchor") === anchor,
                spotlightMatches:
                  document
                    .querySelector('[data-testid="guide-spotlight"]')
                    ?.getAttribute("data-guide-anchor") === anchor,
                visible: target.isConnected && visible(target) && firstVisible() === target,
                inViewport: entry.intersectionRatio >= 0.5,
                insidePane:
                  !node ||
                  Boolean(
                    frame &&
                    box.left >= frame.left &&
                    box.right <= frame.right &&
                    box.top >= frame.top &&
                    box.bottom <= frame.bottom,
                  ),
              });
            });
            observer.observe(target);
          });
        }),
      { timeout: 15000 },
    )
    .toEqual({
      guideId,
      stepId,
      anchored: true,
      spotlightMatches: true,
      visible: true,
      inViewport: true,
      insidePane: true,
    });
}

/** Sign in as a new account; `label` keeps the address readable in logs. */
export async function freshReader(page: Page, label: string, hidePanels = false): Promise<void> {
  const email = `guides-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await createTestUser(email, PASSWORD, `Guides ${label}`)).success).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, email, PASSWORD);
  const saved = await page.request.put(`${BASE_URL}/api/settings`, {
    headers: { Origin: new URL(BASE_URL).origin },
    data: {
      "ui.guide_progress": { firstRun: "declined" },
      "ui.hidden_panels": hidePanels ? BEGINNER_PANELS : [],
    },
  });
  expect(saved.ok()).toBe(true);
}
