/**
 * The tutorial "Build your first flow", lessons 0–3, walked by hand as a new reader in English and
 * in Russian: started from the guide menu on the example, the copy made with "Use as Template",
 * a step added to the Do block and connected with its label. Each lesson's first check names what
 * is missing on the card and on the definition, and a lesson completes only after the save;
 * progress then holds the copy and each passed lesson's revision. A second start reuses the copy,
 * and a save against a revision changed elsewhere is refused with the card's explanation.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { freshReader } from "./helpers/guides.js";

const BASE_URL = getTestBaseUrl();
const card = (page: Page) => page.getByTestId("tutorial-card");

async function progressOf(page: Page) {
  const response = await page.request.get(`${BASE_URL}/api/settings/ui`);
  const body = (await response.json()) as { data: Record<string, any> };
  return body.data["ui.guide_progress"]?.tutorials?.["build-flow"];
}

async function openFromMenu(page: Page) {
  await page.getByTestId("show-me-around").click();
  await page.getByTestId("show-me-around-tutorial").click();
}

async function saveWhenChecked(page: Page) {
  await expect(page.getByTestId("flow-edit-gate")).toHaveAttribute("data-gate", "ready", {
    timeout: 15000,
  });
  await page.getByTestId("flow-edit-save").click();
  await expect(page.getByTestId("flow-edit-count")).toContainText("0");
}

for (const language of ["en", "ru"] as const) {
  test(`lessons 0–3 by hand, in ${language}: checked on the draft, completed only when saved`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await freshReader(page, `tutorial-${language}`);
    await page.addInitScript((lng) => localStorage.setItem("i18nextLng", lng), language);
    await page.goto(`${BASE_URL}/`);
    await openFromMenu(page);
    const example = language === "ru" ? "example-simple-steps-ru" : "example-simple-steps";
    await expect(page).toHaveURL(new RegExp(`/workflows/moira/${example}\\?.*guide=build-flow`));
    await expect(card(page)).toHaveAttribute("data-lesson", "lesson-0");
    await page.getByTestId("tutorial-next").click();

    // Lesson 1: the copy, made by hand; the tutorial goes on on the copy.
    await expect(card(page)).toHaveAttribute("data-lesson", "lesson-1");
    await expect(page.getByTestId("tutorial-next")).toBeDisabled();
    await page.getByTestId("tutorial-spotlight").waitFor();
    await page.locator('[data-guide~="flow.use-template"]').click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}\?.*guide=build-flow/);
    const copyId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(card(page)).toHaveAttribute("data-status", "complete", { timeout: 15000 });
    await expect.poll(async () => (await progressOf(page))?.copyId).toBe(copyId);

    try {
      // Lesson 2: the untouched copy fails with its code; the step added by hand passes once saved.
      await page.getByTestId("tutorial-next").click();
      await expect(card(page)).toHaveAttribute("data-lesson", "lesson-2");
      await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
      // The editor tour's offer waits while the tutorial teaches.
      await expect(page.getByTestId("editor-tour-offer")).toHaveCount(0);
      await expect(
        page.getByTestId("tutorial-findings").locator('[data-code="new-step-missing"]'),
      ).toBeVisible();
      await page.getByTestId("block-add-step-work").click();
      await page.getByTestId("add-step-id").fill("save-draft");
      await page.getByTestId("add-step-field-directive").fill("Keep a draft of the work.");
      await page.getByTestId("add-step-field-completionCondition").fill("A draft is kept.");
      await page.getByTestId("add-step-confirm").click();
      // A step must lead somewhere to be saved; the connection into Check needs its label.
      await page.getByTestId("connection-new-key-save-draft").fill("success");
      await page.getByTestId("connection-new-target-save-draft").click();
      await page.locator('[role="option"][data-target="check-result"]').click();
      await page.getByTestId("connection-add-save-draft").click();
      await expect(card(page)).toHaveAttribute("data-status", "save");
      await page.locator('[data-edges="save-draft.success"]').first().click();
      await page.getByTestId("edit-transition-label").fill("draft kept");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("tutorial-next")).toBeDisabled();
      await saveWhenChecked(page);
      await expect(card(page)).toHaveAttribute("data-status", "complete", { timeout: 15000 });

      // Lesson 3: nothing leads to the new step, which the check names on the step itself.
      await page.getByTestId("tutorial-next").click();
      await expect(card(page)).toHaveAttribute("data-lesson", "lesson-3");
      await expect(
        page.getByTestId("tutorial-findings").locator('[data-code="new-step-not-connected"]'),
      ).toBeVisible();
      await expect(page.locator('[data-node-id="save-draft"]').first()).toContainText(
        language === "ru" ? "не ведёт ни один путь" : "No route reaches",
      );
      await page.getByTestId("connection-target-do-task-success").click();
      await page.locator('[role="option"][data-target="save-draft"]').click();
      await expect(card(page)).toHaveAttribute("data-status", "save");
      await saveWhenChecked(page);
      await expect(card(page)).toHaveAttribute("data-status", "complete", { timeout: 15000 });

      // The page records the lesson at once; the setting reaches the server a moment later.
      await expect
        .poll(async () => Object.keys((await progressOf(page))?.lessons ?? {}).sort())
        .toEqual(["lesson-1", "lesson-2", "lesson-3"]);
      const own = await progressOf(page);
      expect(own.copyId).toBe(copyId);
      expect(own.lessons["lesson-3"].revision).toBeGreaterThan(own.lessons["lesson-2"].revision);
      expect(own.lessons["lesson-2"].forMe).toBeUndefined();
    } finally {
      await page.request.delete(`${BASE_URL}/api/workflows/${copyId}`);
    }
  });
}

test("a second start reuses the copy, and a save refused on a stale revision is explained", async ({
  page,
}) => {
  test.setTimeout(90000);
  await freshReader(page, "tutorial-stale");
  await page.goto(`${BASE_URL}/`);
  await openFromMenu(page);
  await expect(card(page)).toHaveAttribute("data-lesson", "lesson-0");
  await page.getByTestId("tutorial-next").click();
  await page.getByTestId("tutorial-for-me").click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}\?.*step=lesson-1/);
  const copyId = new URL(page.url()).pathname.split("/").pop()!;
  try {
    await expect(card(page)).toHaveAttribute("data-status", "complete", { timeout: 15000 });
    await expect
      .poll(async () => (await progressOf(page))?.lessons?.["lesson-1"]?.forMe)
      .toBe(true);

    // Started again from the menu: the same copy, at the first lesson not passed.
    await page.goto(`${BASE_URL}/`);
    await openFromMenu(page);
    await expect(page).toHaveURL(new RegExp(`/workflows/${copyId}\\?.*step=lesson-2`));

    // The copy changes elsewhere; the next save from this page is refused and explained.
    await page.getByTestId("tutorial-for-me").click();
    const detail = await (await page.request.get(`${BASE_URL}/api/workflows/${copyId}`)).json();
    const current = detail.data;
    const changed = await page.request.put(`${BASE_URL}/api/workflows/${copyId}`, {
      headers: { Origin: new URL(BASE_URL).origin },
      data: {
        workflow: {
          ...current.workflow,
          metadata: { ...current.workflow.metadata, description: "Changed elsewhere." },
        },
        expectedRevision: current.fileInfo.revision,
      },
    });
    expect(changed.ok()).toBe(true);
    await saveWhenCheckedAllowingRefusal(page);
    await expect(card(page)).toHaveAttribute("data-status", "conflict");
    await page.getByRole("button", { name: /Reload the copy/ }).click();
    await expect(card(page)).not.toHaveAttribute("data-status", "conflict");
    // "Do it for me" stays spent for this lesson after a reload.
    await expect.poll(async () => (await progressOf(page))?.forMe?.["lesson-2"]).toBe(true);
    await page.reload();
    await expect(page.getByTestId("tutorial-for-me")).toBeDisabled();

    // The copy is deleted: the next start begins again on the example and makes a new copy.
    await page.request.delete(`${BASE_URL}/api/workflows/${copyId}`);
    await page.goto(`${BASE_URL}/`);
    await openFromMenu(page);
    await expect(page).toHaveURL(/\/workflows\/moira\/example-simple-steps\?.*step=lesson-0/);
    await expect.poll(async () => (await progressOf(page))?.copyId).toBeUndefined();
    await page.getByTestId("tutorial-next").click();
    await page.getByTestId("tutorial-for-me").click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}\?.*step=lesson-1/);
    const second = new URL(page.url()).pathname.split("/").pop()!;
    expect(second).not.toBe(copyId);
    await page.request.delete(`${BASE_URL}/api/workflows/${second}`);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${copyId}`);
  }
});

async function saveWhenCheckedAllowingRefusal(page: Page) {
  await expect(page.getByTestId("flow-edit-gate")).toHaveAttribute("data-gate", "ready", {
    timeout: 15000,
  });
  await page.getByTestId("flow-edit-save").click();
}
