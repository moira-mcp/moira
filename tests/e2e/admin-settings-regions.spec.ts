import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const valuesPath = "/api/admin/global-settings";
const definitionsPath = "/api/admin/settings/definitions";

async function selectTab(page: Page, tab: string) {
  await page.getByTestId(`admin-settings-nav-${tab}`).click();
  await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe(tab);
}

test.describe("Admin settings retained regions", () => {
  // These cases change shared global settings and restore them before the next case.
  test.describe.configure({ mode: "default" });
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const [language, label] of [
    ["en", "Notify administrators of new registrations"],
    ["ru", "Уведомлять администраторов о новых регистрациях"],
  ] as const) {
    test(`mobile registration settings stay inside their row and support keyboard actions (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const key = "system.notify_admins_on_registration";
      const initial = await page.request.get(valuesPath);
      expect(initial.ok()).toBe(true);
      const originalValue = (await initial.json()).data.settings.find(
        (entry: { key: string }) => entry.key === key,
      ).value;
      try {
        await page.goto(`/admin/settings?tab=values&lang=${language}`);
        await page.getByTestId("setting-category-system-chevron").click();
        const row = page.getByTestId(`setting-${key}`);
        const checkbox = row.getByRole("checkbox", { name: label, exact: true });
        await expect(checkbox).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        const outside = await row.evaluate((element) => {
          const rowBox = element.getBoundingClientRect();
          return Array.from(element.querySelectorAll("span,button,input,svg")).flatMap((item) => {
            const box = item.getBoundingClientRect();
            if (
              box.width === 0 ||
              box.height === 0 ||
              getComputedStyle(item).visibility === "hidden"
            )
              return [];
            return box.left < rowBox.left - 1 ||
              box.right > rowBox.right + 1 ||
              box.left < -1 ||
              box.right > innerWidth + 1
              ? [
                  {
                    label: item.getAttribute("aria-label") ?? item.textContent,
                    left: box.left,
                    right: box.right,
                    rowLeft: rowBox.left,
                    rowRight: rowBox.right,
                    viewport: innerWidth,
                  },
                ]
              : [];
          });
        });
        expect(outside).toEqual([]);
        const help = row.getByTestId(`setting-${key}-help`);
        await help.focus();
        await expect(help).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId(`setting-${key}-help-content`)).toContainText(
          language === "en" ? "personal Telegram settings" : "личные настройки Telegram",
        );
        await page.keyboard.press("Escape");
        await expect(page.getByTestId(`setting-${key}-help-content`)).toBeHidden();
        await expect(help).toBeFocused();
        const history = row.getByTestId(`setting-${key}-history`);
        await history.focus();
        const historyRead = page.waitForResponse(
          (response) => new URL(response.url()).pathname === `${valuesPath}/${key}/history`,
        );
        await page.keyboard.press("Enter");
        expect((await historyRead).ok()).toBe(true);
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
        const wasEnabled = await checkbox.isChecked();
        await checkbox.focus();
        await page.keyboard.press("Space");
        const save = row.getByTestId(`setting-${key}-save`);
        await expect(save).toBeEnabled();
        await save.focus();
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `${valuesPath}/${key}` &&
            response.request().method() === "PUT",
        );
        await page.keyboard.press("Enter");
        const response = await saved;
        expect(response.ok()).toBe(true);
        expect(response.request().postDataJSON()).toEqual({ value: String(!wasEnabled) });
        await expect(save).toBeDisabled();
        await expect(checkbox).toBeChecked({ checked: !wasEnabled });
      } finally {
        expect(
          (await page.request.put(`${valuesPath}/${key}`, { data: { value: originalValue } })).ok(),
        ).toBe(true);
      }
    });
  }

  for (const [language, label] of [
    ["en", "Notify administrators of new registrations"],
    ["ru", "Уведомлять администраторов о новых регистрациях"],
  ] as const) {
    test(`the ${language} registration preference persists both states through the real settings UI`, async ({
      page,
    }) => {
      const key = "system.notify_admins_on_registration";
      const initial = await page.request.get(valuesPath);
      expect(initial.ok()).toBe(true);
      const initialSettings = (await initial.json()).data.settings as {
        key: string;
        value: string | null;
        type: string;
      }[];
      const setting = initialSettings.find((entry) => entry.key === key);
      expect(setting?.type).toBe("boolean");
      const originalValue = setting!.value;
      try {
        const path = language === "en" ? "/admin/global-settings" : "/admin/settings?tab=values";
        await page.goto(`${path}${path.includes("?") ? "&" : "?"}lang=${language}`);
        await expect(page.getByTestId("tab-values")).toBeVisible();
        await page.getByTestId("setting-category-system-chevron").click();
        const checkbox = page.getByRole("checkbox", { name: label, exact: true });
        await expect(checkbox).toBeVisible();
        const draft = page.getByTestId("mcp-prompt-systemPrompt-input");
        await expect(draft).toBeVisible();
        await draft.fill("Unfinished neighbouring prompt");
        const originalDraft = await draft.elementHandle();

        for (const enabled of [false, true]) {
          // First move to the opposite state if it was already saved, so every save is a mutation.
          if ((await checkbox.isChecked()) === enabled) {
            await checkbox.setChecked(!enabled);
            const [prepared] = await Promise.all([
              page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === `${valuesPath}/${key}` &&
                  response.request().method() === "PUT",
              ),
              page.getByTestId(`setting-${key}-save`).click(),
            ]);
            expect(prepared.ok()).toBe(true);
          }
          await checkbox.setChecked(enabled);
          const [saved] = await Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === `${valuesPath}/${key}` &&
                response.request().method() === "PUT",
            ),
            page.getByTestId(`setting-${key}-save`).click(),
          ]);
          expect(saved.ok()).toBe(true);
          expect(saved.request().postDataJSON()).toEqual({ value: String(enabled) });
          await expect(page.getByTestId(`setting-${key}-save`)).toBeDisabled();
          const persisted = await page.request.get(valuesPath);
          expect(persisted.ok()).toBe(true);
          expect(
            (await persisted.json()).data.settings.find(
              (entry: { key: string }) => entry.key === key,
            ).value,
          ).toBe(String(enabled));
          await expect(draft).toHaveValue("Unfinished neighbouring prompt");
          expect(await originalDraft!.evaluate((element) => element.isConnected)).toBe(true);
          await selectTab(page, "maintenance");
          await selectTab(page, "values");
          await expect(checkbox).toBeChecked({ checked: enabled });
          await expect(draft).toHaveValue("Unfinished neighbouring prompt");
        }
      } finally {
        const restored = await page.request.put(`${valuesPath}/${key}`, {
          data: { value: originalValue },
        });
        expect(restored.ok()).toBe(true);
      }
    });
  }

  test("query deep links and the values alias keep caller navigation and maintenance actions", async ({
    page,
  }) => {
    await page.goto("/admin/settings?tab=maintenance&lang=en&keep=reader");
    await expect(page.getByTestId("tab-maintenance")).toBeVisible();
    await page.getByRole("button", { name: "Backup", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Create database backup?");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Vacuum", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Vacuum database?");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await selectTab(page, "definitions");
    expect(new URL(page.url()).searchParams.get("keep")).toBe("reader");
    await expect(
      page.getByRole("button", { name: "Create Definition", exact: true }),
    ).toBeEnabled();

    await page.goto("/admin/global-settings?lang=en");
    await expect(page.getByTestId("tab-values")).toBeVisible();
    await expect(page.getByTestId("mcp-prompt-systemPrompt-input")).toBeVisible();
    await selectTab(page, "codespaces");
    await expect(page.getByTestId("admin-codespace-control-global")).toBeVisible();
  });

  test("a native delayed and refused codespace read retains the same focused reason and neighbouring tab", async ({
    page,
  }) => {
    await page.goto("/admin/settings?tab=codespaces&lang=en");
    const region = page.getByTestId("admin-codespace-controls");
    const input = page.locator('[id="codespace-control-reason-global"]');
    await expect(input).toBeVisible();
    await input.fill("Unsaved operator reason");
    const original = await input.elementHandle();
    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const pattern = "**/api/admin/codespaces";
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      received();
      await held;
      await route.abort("failed");
    });
    try {
      await region.getByRole("button", { name: /Refresh/i }).click();
      await arrived;
      await input.focus();
      await expect(region).toHaveAttribute("aria-busy", "true");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Unsaved operator reason");
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      release();
      await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Unsaved operator reason");
      await selectTab(page, "maintenance");
      await expect(page.getByRole("button", { name: "Backup", exact: true })).toBeEnabled();
      await page.unroute(pattern);
      await selectTab(page, "codespaces");
      await expect(region).toHaveAttribute("aria-busy", "false");
      await expect(region.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect(input).toHaveValue("Unsaved operator reason");
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    } finally {
      release();
      await page.unroute(pattern);
    }
  });

  test("real value editing, history and exported import survive tab revisits", async ({ page }) => {
    await page.goto("/admin/settings?tab=values&lang=en");
    const key = "notes.max_versions";
    const response = await page.request.get(valuesPath);
    expect(response.ok()).toBe(true);
    const settings = (await response.json()).data.settings as {
      key: string;
      value: string | null;
    }[];
    const stored = settings.find((setting) => setting.key === key);
    expect(stored).toBeDefined();
    const originalValue = stored!.value;
    try {
      await page.getByTestId("setting-category-notes-chevron").click();
      const input = page.getByTestId(`setting-${key}-input`);
      await expect(input).toBeVisible();
      const originalEditorValue = await input.inputValue();
      const changed = originalValue === "17" ? "19" : "17";
      await input.fill(changed);
      const [saved] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `${valuesPath}/${key}` && r.request().method() === "PUT",
        ),
        page.getByTestId(`setting-${key}-save`).click(),
      ]);
      expect(saved.ok()).toBe(true);
      await expect(page.getByTestId(`setting-${key}-save`)).toBeDisabled();
      const [history] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === `${valuesPath}/${key}/history`),
        page.getByTestId(`setting-${key}-history`).click(),
      ]);
      expect(history.ok()).toBe(true);
      await expect(
        page.getByRole("dialog").locator('[data-testid^="version-"]').first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("export-settings").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^moira-settings-.*\.json$/);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const exported = JSON.parse(Buffer.concat(chunks).toString()) as {
        values: Record<string, string | null>;
      };
      expect(exported.values[key]).toBe(changed);
      // Import the real exported value after a genuine source mutation, rather than fabricated API data.
      const altered = await page.request.put(`${valuesPath}/${key}`, {
        data: { value: originalValue },
      });
      expect(altered.ok()).toBe(true);
      await selectTab(page, "definitions");
      await selectTab(page, "values");
      await expect(input).toHaveValue(originalEditorValue);
      await page.getByTestId("import-file-input").setInputFiles({
        name: download.suggestedFilename(),
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(exported)),
      });
      await expect(page.getByTestId(`import-change-${key}`)).toContainText("Overwrite");
      const [imported] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `${valuesPath}/${key}` && r.request().method() === "PUT",
        ),
        page.getByTestId("import-confirm").click(),
      ]);
      expect(imported.ok()).toBe(true);
      await expect(page.getByTestId("import-preview-list")).toHaveCount(0);
      await expect(input).toHaveValue(changed);
      const final = await page.request.get(valuesPath);
      expect(final.ok()).toBe(true);
      expect(
        (await final.json()).data.settings.find((s: { key: string }) => s.key === key).value,
      ).toBe(changed);
    } finally {
      const restored = await page.request.put(`${valuesPath}/${key}`, {
        data: { value: originalValue },
      });
      expect(restored.ok()).toBe(true);
    }
  });

  test("definition creation and deletion use the real schema while the form retains its draft across tabs", async ({
    page,
  }) => {
    await page.goto("/admin/settings?tab=definitions&lang=en");
    const key = `unit4.browser_${Date.now()}`;
    const keyInput = page.getByRole("textbox", {
      name: "Key (e.g., telegram.bot_token)",
      exact: true,
    });
    await keyInput.fill(key);
    await page.getByRole("combobox", { name: "Select Type", exact: true }).click();
    await page.getByRole("option", { name: "string", exact: true }).click();
    await page.getByRole("textbox", { name: "Category", exact: true }).fill("test");
    await page.getByRole("textbox", { name: "Label", exact: true }).fill("Browser setting");
    await selectTab(page, "maintenance");
    await selectTab(page, "definitions");
    await expect(keyInput).toHaveValue(key);
    try {
      const [created] = await Promise.all([
        page.waitForResponse(
          (r) => new URL(r.url()).pathname === definitionsPath && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Create Definition", exact: true }).click(),
      ]);
      expect(created.ok()).toBe(true);
      const card = page.getByTestId(`definition-${key}`);
      await expect(card).toContainText("string");
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      const [deleted] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `${definitionsPath}/${key}` &&
            r.request().method() === "DELETE",
        ),
        page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click(),
      ]);
      expect(deleted.ok()).toBe(true);
      await expect(card).toHaveCount(0);
    } finally {
      const current = await page.request.get(definitionsPath);
      expect(current.ok()).toBe(true);
      const definitions = (await current.json()).data as { key: string }[];
      if (definitions.some((definition) => definition.key === key)) {
        expect((await page.request.delete(`${definitionsPath}/${key}`)).ok()).toBe(true);
      }
    }
  });

  test("a downloaded schema restores its own changed definition only after type-change confirmation", async ({
    page,
  }) => {
    const key = `unit4.schema_${Date.now()}_${test.info().workerIndex}`;
    try {
      const created = await page.request.post(definitionsPath, {
        data: {
          key,
          type: "string",
          category: "test",
          label: "Schema round trip",
          description: "Exported schema fixture",
          defaultValue: "original",
          adminOnly: true,
        },
      });
      expect(created.ok()).toBe(true);
      await page.goto("/admin/settings?tab=definitions&lang=en");
      const card = page.getByTestId(`definition-${key}`);
      await expect(card).toContainText("Exported schema fixture");
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("export-schema").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^moira-schema-.*\.json$/);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const exported = JSON.parse(Buffer.concat(chunks).toString()) as {
        version: string;
        exportedAt: string;
        definitions: Array<{
          key: string;
          type: string;
          description: string | null;
          defaultValue: string | null;
          adminOnly: boolean;
        }>;
      };
      expect(exported.version).toBe("1.0");
      expect(Number.isFinite(Date.parse(exported.exportedAt))).toBe(true);
      const ownDefinition = exported.definitions.find((definition) => definition.key === key);
      expect(ownDefinition).toMatchObject({
        key,
        type: "string",
        description: "Exported schema fixture",
        defaultValue: "original",
        adminOnly: true,
      });
      const altered = await page.request.put(`${definitionsPath}/${key}`, {
        data: { type: "number", description: "Changed schema fixture" },
      });
      expect(altered.ok()).toBe(true);
      await selectTab(page, "maintenance");
      await selectTab(page, "definitions");
      await expect(card).toContainText("Changed schema fixture");
      await expect(card).toContainText("Type: number");
      // Keep the server's exported definition intact and import only this test's own key.
      await page.getByTestId("import-schema-file-input").setInputFiles({
        name: download.suggestedFilename(),
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ ...exported, definitions: [ownDefinition] })),
      });
      await expect(page.getByTestId(`schema-change-${key}`)).toContainText("number → string");
      const confirm = page.getByTestId("schema-import-confirm");
      await expect(confirm).toBeDisabled();
      await page.getByTestId("schema-type-change-confirm").check();
      await expect(confirm).toBeEnabled();
      const [imported] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `${definitionsPath}/${key}` &&
            response.request().method() === "PUT",
        ),
        confirm.click(),
      ]);
      expect(imported.ok()).toBe(true);
      expect(imported.request().postDataJSON()).toMatchObject(ownDefinition!);
      await expect(page.getByTestId("schema-import-preview-list")).toHaveCount(0);
      await expect(card).toContainText("Type: string");
      await expect(card).toContainText("Exported schema fixture");
      const persisted = await page.request.get(definitionsPath);
      expect(persisted.ok()).toBe(true);
      expect(
        (await persisted.json()).data.find((definition: { key: string }) => definition.key === key),
      ).toMatchObject(ownDefinition!);
    } finally {
      const remaining = await page.request.get(definitionsPath);
      expect(remaining.ok()).toBe(true);
      if (
        (await remaining.json()).data.some((definition: { key: string }) => definition.key === key)
      ) {
        expect((await page.request.delete(`${definitionsPath}/${key}`)).ok()).toBe(true);
      }
    }
  });

  test("confirmed vacuum completes against the real database while neighbouring actions and a definitions draft remain available", async ({
    page,
  }) => {
    await page.goto("/admin/settings?tab=definitions&lang=en");
    const keyInput = page.getByRole("textbox", {
      name: "Key (e.g., telegram.bot_token)",
      exact: true,
    });
    await keyInput.fill("unsaved.vacuum_draft");
    await selectTab(page, "maintenance");
    await page.getByRole("button", { name: "Vacuum", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Vacuum database?");
    const [vacuumed] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/admin/database/vacuum" &&
          response.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: "Vacuum", exact: true }).click(),
    ]);
    expect(vacuumed.ok()).toBe(true);
    expect(await vacuumed.json()).toMatchObject({
      success: true,
      data: { message: "Database vacuumed successfully" },
    });
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Backup", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Vacuum", exact: true })).toBeEnabled();
    await selectTab(page, "definitions");
    await expect(keyInput).toHaveValue("unsaved.vacuum_draft");
    await expect(
      page.getByRole("button", { name: "Create Definition", exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId("import-schema")).toBeEnabled();
  });

  test("a late native prompt-scope reply cannot replace the selected scope or its draft", async ({
    page,
  }) => {
    await page.goto("/admin/settings?tab=values&lang=en");
    const input = page.getByTestId("mcp-prompt-systemPrompt-input");
    const scope = page.getByTestId("mcp-prompt-systemPrompt-scope");
    await expect(input).toBeVisible();
    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const pattern = "**/api/admin/global-settings/get-scope-value";
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (route.request().postDataJSON().vendor === "claude") {
        received();
        await held;
      }
      await route.fulfill({ response });
    });
    try {
      await scope.click();
      await page.getByRole("option", { name: "Claude", exact: true }).click();
      await arrived;
      await scope.click();
      const [current] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname.endsWith("/get-scope-value") &&
            r.request().postDataJSON().vendor === "chatgpt",
        ),
        page.getByRole("option", { name: "ChatGPT", exact: true }).click(),
      ]);
      expect(current.ok()).toBe(true);
      await expect(page.getByTestId("mcp-prompt-systemPrompt")).toContainText(
        "Override for all ChatGPT models",
      );
      await input.fill("Unsaved ChatGPT prompt");
      await input.focus();
      const late = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.endsWith("/get-scope-value") &&
          r.request().postDataJSON().vendor === "claude",
      );
      release();
      await (await late).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(scope).toContainText("ChatGPT");
      await expect(input).toHaveValue("Unsaved ChatGPT prompt");
      await expect(input).toBeFocused();
      await expect(page.getByTestId("mcp-prompt-systemPrompt")).toContainText(
        "Override for all ChatGPT models",
      );
    } finally {
      release();
      await page.unroute(pattern);
    }
  });
});
