/** Modal contents stay clickable across exit/reopen, child portals and nested confirmations. */
import { test, expect, type Locator, type Page } from "./fixtures.js";
import { createTestUser, loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

async function expectHitTarget(button: Locator) {
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    )
    .toBe(true);
}

/** Hold the real exit animation, so reopening must reuse content whose overlay already left. */
async function reopenDuringExit(page: Page, content: Locator, trigger: Locator, overlay: string) {
  const retained = await content.elementHandle();
  const originalTrigger = await trigger.elementHandle();
  expect(originalTrigger).not.toBeNull();
  await content.evaluate((element) => {
    const observer = new MutationObserver(() => {
      if (element.getAttribute("data-state") !== "closed") return;
      // Install before Cancel; retaining the exit cannot race an awaited browser command.
      element.getAnimations().forEach((animation) => animation.pause());
      observer.disconnect();
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-state"] });
  });
  await content.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(content).toHaveAttribute("data-state", "closed");
  await expect(page.locator(`[data-slot="${overlay}"]`)).toHaveCount(0);
  // The retained closing box may still cover the trigger. Keyboard activation reopens through
  // the actual control, without forcing a pointer through that native exit animation.
  await originalTrigger!.focus();
  await originalTrigger!.press("Enter");
  await expect(content).toHaveAttribute("data-state", "open");
  expect(await content.evaluate((element, previous) => element === previous, retained)).toBe(true);
}

async function withCopiedFlow(page: Page, run: (id: string) => Promise<void>) {
  const copied = await page.request.post(`${BASE_URL}/api/workflows/moira/quick-task/copy`, {
    data: { newName: `Modal layering ${Date.now()}` },
  });
  expect(copied.status()).toBe(200);
  const id = ((await copied.json()) as { data: { workflowId: string } }).data.workflowId;
  try {
    await run(id);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test("a confirmation keyboard-reopened during its previous exit accepts a real click", async ({
  page,
}) => {
  const created = await createTestUser(
    `modal-reset-${Date.now()}@test.com`,
    "TestPassword123!",
    "Modal Reset",
  );
  expect(created.success).toBe(true);
  expect(created.userId).toBeTruthy();
  await page.goto(`${BASE_URL}/admin/users/${created.userId}`);
  // The closed dialog remains aria-visible during its retained exit; distinguish the page's
  // Button from the confirmation action, which has the same accessible name.
  const trigger = page
    .locator('button[data-slot="button"]')
    .filter({ hasText: /^Force Password Reset$/ });
  await trigger.click();
  const dialog = page.locator('[data-slot="alert-dialog-content"]');
  await reopenDuringExit(page, dialog, trigger, "alert-dialog-overlay");
  const confirm = dialog.getByRole("button", { name: "Force Password Reset", exact: true });
  await expectHitTarget(confirm);
  await confirm.click();
  await expect(page.getByText("Password Reset Required", { exact: true }).first()).toBeVisible();
});

test("an editor keyboard-reopened during exit keeps its portaled select clickable", async ({
  page,
}) => {
  await withCopiedFlow(page, async (id) => {
    await page.goto(`${BASE_URL}/workflows/${id}?view=map&edit=1`);
    const trigger = page.getByTestId("block-add");
    await trigger.click();
    const dialog = page.getByTestId("add-block-dialog");
    await reopenDuringExit(page, dialog, trigger, "dialog-overlay");
    await page.getByTestId("add-block-after").click();
    const option = page.getByRole("option", { name: /Understand the task/ });
    await expectHitTarget(option);
    await option.click();
    await expect(page.getByTestId("add-block-after")).toContainText("Understand the task");
    await page.getByTestId("add-block-id").fill("layering-test");
    await page.getByTestId("add-block-label").fill("Layering test");
    await page.getByTestId("add-block-summary").fill("A block added through a reopened dialog.");
    const confirm = page.getByTestId("add-block-confirm");
    await expectHitTarget(confirm);
    await confirm.click();
    await expect(page.getByTestId("map-contents-layering-test")).toBeVisible();
  });
});

test("a nested confirmation dims its parent and completes through its own button", async ({
  page,
}) => {
  await withCopiedFlow(page, async (id) => {
    const invite = await page.request.post(`${BASE_URL}/api/workflows/${id}/invites`, { data: {} });
    expect(invite.ok()).toBe(true);
    await page.goto(`${BASE_URL}/workflows/${id}`);
    await page.getByTestId("share-workflow-button").click();
    await page.getByTestId("revoke-invite-button").click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toBeVisible();
    // A point on the underlying Share dialog must hit the newer confirmation's backdrop.
    expect(
      await page.locator('[data-slot="dialog-content"]').evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + 4, box.top + 4);
        return hit?.getAttribute("data-slot");
      }),
    ).toBe("alert-dialog-overlay");
    const confirm = confirmation.getByRole("button", { name: "Delete", exact: true });
    await expectHitTarget(confirm);
    await confirm.click();
    await expect(page.getByTestId("invite-item")).toHaveCount(0);
    await expect(page.getByTestId("generate-invite-button")).toBeVisible();
  });
});
