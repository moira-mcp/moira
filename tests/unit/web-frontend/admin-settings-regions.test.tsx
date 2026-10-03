/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient, MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import axios from "axios";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { AdminSettings } from "../../../packages/web-frontend/src/pages/AdminSettings";
import { SystemSettings } from "../../../packages/web-frontend/src/pages/SystemSettings";
import { McpPromptsEditor } from "../../../packages/web-frontend/src/components/settings/McpPromptsEditor";
import { AdminSettingsUnified } from "../../../packages/web-frontend/src/pages/AdminSettingsUnified";
import { AdminCodespaceControls } from "../../../packages/web-frontend/src/pages/AdminCodespaceControls";
import { MemoryRouter, useLocation } from "react-router-dom";
import { toast } from "sonner";
import {
  observeReadSession,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";

const row = (key: string, type: string, value: string | null) => ({
  key,
  type,
  value,
  label: key,
  category: "system",
  description: null,
  sortOrder: 0,
  updatedAt: 1,
  updatedBy: null,
});
const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
  jest
    .spyOn(apiClient, "getMcpPromptScopeValue")
    .mockResolvedValue({ key: "mcp.systemPrompt", value: null, exists: true, scope: "default" });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});
function show(children: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{children}</I18nextProvider>);
}
async function expandCategory() {
  const category = await screen.findByTestId("setting-category-system");
  fireEvent.click(category.querySelector("[aria-expanded]")!);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Global values through the shared settings editor", () => {
  test("a newer registration checkbox choice survives an older pending save and can be saved next", async () => {
    const key = "system.notify_admins_on_registration";
    const originalFetch = globalThis.fetch;
    const originalAdapter = axios.defaults.adapter;
    const held = deferred<void>();
    let stored = "true";
    let pendingWrite = false;
    const session = {
      user: {
        id: "settings-admin",
        name: "Admin",
        email: "admin@example.test",
        emailVerified: true,
      },
      session: {
        id: "settings-session",
        userId: "settings-admin",
        token: "fixture-session",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/get-session")) return Response.json(session);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    axios.defaults.adapter = async (config) => {
      const path = new URL(config.url!, "http://localhost").pathname;
      if (config.method === "put") {
        expect(decodeURIComponent(path)).toBe(`/admin/global-settings/${key}`);
        const body = JSON.parse(config.data as string) as { value: string };
        if (body.value === "false") {
          pendingWrite = true;
          await held.promise;
        }
        stored = body.value;
        return { config, status: 200, statusText: "OK", headers: {}, data: { success: true } };
      }
      expect(path).toBe("/admin/global-settings");
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: { success: true, data: { settings: [row(key, "boolean", stored)], grouped: {} } },
      };
    };
    const client = new MoiraApiClient();
    jest
      .spyOn(apiClient, "getGlobalSettings")
      .mockImplementation(client.getGlobalSettings.bind(client));
    jest
      .spyOn(apiClient, "updateGlobalSetting")
      .mockImplementation(client.updateGlobalSetting.bind(client));
    try {
      await authClient.$store.atoms.session.get().refetch();
      await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
      show(<AdminSettings embedded />);
      await expandCategory();
      const checkbox = screen.getByTestId(`setting-${key}-input`);
      const save = screen.getByTestId(`setting-${key}-save`);
      fireEvent.click(checkbox);
      fireEvent.click(save);
      await waitFor(() => expect(pendingWrite).toBe(true));
      expect(save).toBeDisabled();
      expect(checkbox).toBeEnabled();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
      await act(async () => held.resolve());
      expect(stored).toBe("false");
      expect(checkbox).toBeChecked();
      expect(save).toBeEnabled();
      fireEvent.click(save);
      await waitFor(() => expect(save).toBeDisabled());
      expect(stored).toBe("true");
      expect(checkbox).toBeChecked();
    } finally {
      held.resolve();
      cleanup();
      axios.defaults.adapter = originalAdapter;
      globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
        if (String(input).includes("/get-session")) return Response.json(null);
        throw new Error(`Unexpected request: ${String(input)}`);
      });
      await authClient.$store.atoms.session.get().refetch();
      await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    [
      "en",
      "Notify administrators of new registrations",
      "Send a Telegram message after a new account registers successfully.",
    ],
    [
      "ru",
      "Уведомлять администраторов о новых регистрациях",
      "Отправлять сообщение в Telegram после успешной регистрации нового аккаунта.",
    ],
  ])(
    "the %s registration preference persists false and true through the native client without losing another draft",
    async (language, label, description) => {
      await i18n.changeLanguage(language);
      const key = "system.notify_admins_on_registration";
      let stored = "true";
      const originalAdapter = axios.defaults.adapter;
      const originalFetch = globalThis.fetch;
      const session = {
        user: {
          id: "settings-admin",
          name: "Admin",
          email: "admin@example.test",
          emailVerified: true,
        },
        session: {
          id: "settings-session",
          userId: "settings-admin",
          token: "fixture-session",
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
        if (String(input).includes("/get-session")) return Response.json(session);
        throw new Error(`Unexpected request: ${String(input)}`);
      });
      axios.defaults.adapter = async (config) => {
        const path = new URL(config.url!, "http://localhost").pathname;
        if (config.method === "put") {
          expect(decodeURIComponent(path)).toBe(`/admin/global-settings/${key}`);
          const body = JSON.parse(config.data as string) as { value: unknown };
          expect(typeof body.value).toBe("string");
          stored = body.value as string;
          return { config, status: 200, statusText: "OK", headers: {}, data: { success: true } };
        }
        expect(path).toBe("/admin/global-settings");
        return {
          config,
          status: 200,
          statusText: "OK",
          headers: {},
          data: {
            success: true,
            data: {
              settings: [
                {
                  ...row(key, "boolean", stored),
                  label: "Server registration label",
                  description: "Server registration description",
                },
                row("probe.text", "text", "saved"),
              ],
              grouped: {},
            },
          },
        };
      };
      const client = new MoiraApiClient();
      jest
        .spyOn(apiClient, "getGlobalSettings")
        .mockImplementation(client.getGlobalSettings.bind(client));
      jest
        .spyOn(apiClient, "updateGlobalSetting")
        .mockImplementation(client.updateGlobalSetting.bind(client));
      try {
        await authClient.$store.atoms.session.get().refetch();
        await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
        show(<AdminSettings embedded />);
        await expandCategory();
        const checkbox = screen.getByRole("checkbox", { name: label });
        expect(checkbox).toBeChecked();
        expect(screen.getByText(description)).toBeInTheDocument();
        const draft = screen.getByTestId("setting-probe.text-input");
        expect(draft).toHaveAttribute("aria-label", "probe.text");
        fireEvent.change(draft, { target: { value: "Unrelated unfinished draft" } });
        fireEvent.click(checkbox);
        fireEvent.click(screen.getByTestId(`setting-${key}-save`));
        await waitFor(() => expect(screen.getByTestId(`setting-${key}-save`)).toBeDisabled());
        expect(stored).toBe("false");
        expect(checkbox).not.toBeChecked();
        expect(screen.getByTestId("setting-probe.text-input")).toBe(draft);
        expect(draft).toHaveValue("Unrelated unfinished draft");
        cleanup();
        show(<AdminSettings embedded />);
        await expandCategory();
        const reopened = screen.getByRole("checkbox", { name: label });
        expect(reopened).not.toBeChecked();
        fireEvent.click(reopened);
        fireEvent.click(screen.getByTestId(`setting-${key}-save`));
        await waitFor(() => expect(screen.getByTestId(`setting-${key}-save`)).toBeDisabled());
        expect(stored).toBe("true");
        cleanup();
        show(<AdminSettings embedded />);
        await expandCategory();
        expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
      } finally {
        cleanup();
        axios.defaults.adapter = originalAdapter;
        globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
          if (String(input).includes("/get-session")) return Response.json(null);
          throw new Error(`Unexpected request: ${String(input)}`);
        });
        await authClient.$store.atoms.session.get().refetch();
        await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
        globalThis.fetch = originalFetch;
      }
    },
  );

  test("a refused generic override reset keeps its accessible confirmation, key and neighbouring draft for retry", async () => {
    const key = "mcp.agent.custom.systemPrompt";
    let stored: string | null = "override";
    const retry = deferred<void>();
    jest.spyOn(apiClient, "getGlobalSettings").mockImplementation(async () => ({
      settings: [row(key, "text", stored), row("probe.text", "text", "saved")],
      grouped: {},
    }));
    const reset = jest
      .spyOn(apiClient, "resetGlobalSetting")
      .mockRejectedValueOnce(new Error("Reset refused by source"))
      .mockImplementation(async (selectedKey) => {
        expect(selectedKey).toBe(key);
        await retry.promise;
        stored = null;
        return { reset: true };
      });
    show(<AdminSettings embedded />);
    await expandCategory();
    const input = screen.getByTestId("setting-probe.text-input");
    fireEvent.change(input, { target: { value: "Neighbouring unfinished draft" } });
    fireEvent.click(screen.getByTestId(`setting-${key}-reset`));
    const dialog = screen.getByRole("alertdialog");
    const label = i18n.t("admin.globalSettings.reset.confirmButton");
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Reset refused by source");
    expect(dialog).toHaveTextContent(key);
    expect(input).toHaveValue("Neighbouring unfinished draft");
    expect(screen.getByTestId(`setting-${key}-input`)).toHaveValue("override");
    const confirm = within(dialog).getByRole("button", { name: label });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(confirm).toBeDisabled();
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId(`setting-${key}-input`)).toHaveValue("");
    expect(input).toHaveValue("Neighbouring unfinished draft");
    expect(reset).toHaveBeenCalledWith(key);
  });

  test("saves false as a stored string and reopens the checkbox unchecked", async () => {
    let stored = "true";
    jest.spyOn(apiClient, "getGlobalSettings").mockImplementation(async () => ({
      settings: [row("probe.enabled", "boolean", stored)],
      grouped: {},
    }));
    jest.spyOn(apiClient, "updateGlobalSetting").mockImplementation(async (_key, value) => {
      stored = value!;
    });
    show(<AdminSettings embedded />);
    await expandCategory();
    const checkbox = await screen.findByTestId("setting-probe.enabled-input");
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("setting-probe.enabled-save"));
    await waitFor(() => expect(stored).toBe("false"));
    await waitFor(() => expect(screen.getByTestId("setting-probe.enabled-save")).toBeDisabled());
    cleanup();
    show(<AdminSettings embedded />);
    await expandCategory();
    expect(await screen.findByTestId("setting-probe.enabled-input")).not.toBeChecked();
  });

  test("keeps another field and its focus when save refresh is delayed, fails, then retries", async () => {
    const settings = [row("probe.text", "text", "saved"), row("probe.enabled", "boolean", "false")];
    const next = deferred<Awaited<ReturnType<typeof apiClient.getGlobalSettings>>>();
    jest
      .spyOn(apiClient, "getGlobalSettings")
      .mockResolvedValueOnce({ settings, grouped: {} })
      .mockImplementationOnce(() => next.promise)
      .mockResolvedValue({ settings, grouped: {} });
    jest.spyOn(apiClient, "updateGlobalSetting").mockResolvedValue();
    show(<AdminSettings embedded />);
    await expandCategory();
    const input = await screen.findByTestId("setting-probe.text-input");
    fireEvent.change(input, { target: { value: "unsaved draft" } });
    fireEvent.click(screen.getByTestId("setting-probe.enabled-input"));
    fireEvent.click(screen.getByTestId("setting-probe.enabled-save"));
    input.focus();
    await waitFor(() => expect(apiClient.getGlobalSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("setting-probe.text-input")).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("unsaved draft");
    await act(async () => {
      next.reject(new Error("unavailable"));
    });
    expect(await screen.findByText("Failed to load settings")).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("unsaved draft");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dataRegion.retry") }));
    await waitFor(() =>
      expect(screen.getByTestId("admin-global-settings-region")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByTestId("setting-probe.text-input")).toBe(input);
    expect(input).toHaveValue("unsaved draft");
  });

  test.each([
    ["boolean", "false", false],
    ["boolean", "1", true],
    ["number", "0", 0],
  ] as const)("renders %s storage %s with its actual value", async (type, stored, expected) => {
    jest
      .spyOn(apiClient, "getGlobalSettings")
      .mockResolvedValue({ settings: [row("probe.value", type, stored)], grouped: {} });
    show(<AdminSettings embedded />);
    await expandCategory();
    const input = await screen.findByTestId("setting-probe.value-input");
    if (type === "boolean") expect((input as HTMLInputElement).checked).toBe(expected);
    else expect(input).toHaveValue(expected);
  });
});

test("deleting a definition keeps the existing definition and unrelated form draft during refresh", async () => {
  const definition = {
    key: "old",
    type: "string",
    category: "system",
    label: "Old",
    description: null,
    defaultValue: null,
    required: false,
    validation: null,
    adminOnly: false,
  };
  const next = deferred<Awaited<ReturnType<typeof apiClient.getSettingDefinitions>>>();
  jest
    .spyOn(apiClient, "getSettingDefinitions")
    .mockResolvedValueOnce([definition])
    .mockImplementationOnce(() => next.promise);
  jest.spyOn(apiClient, "deleteSettingDefinition").mockResolvedValue();
  show(<SystemSettings embedded hideMaintenance />);
  const existing = await screen.findByTestId("definition-old");
  const draft = screen.getByPlaceholderText("Key (e.g., telegram.bot_token)");
  fireEvent.change(draft, { target: { value: "draft.key" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
  await waitFor(() => expect(apiClient.getSettingDefinitions).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("definition-old")).toBe(existing);
  expect(draft).toHaveValue("draft.key");
  await act(async () => next.resolve([]));
  expect(draft).toHaveValue("draft.key");
});

test("switching prompt type preserves its dirty draft and a failed save keeps it editable", async () => {
  const onSave = jest.fn(async () => {
    throw new Error("save refused");
  });
  show(
    <McpPromptsEditor
      onFetchValue={async (type) => ({ key: `mcp.${type}`, value: type })}
      onSave={onSave}
      onReset={async () => {}}
    />,
  );
  const input = await screen.findByTestId("mcp-prompt-systemPrompt-input");
  fireEvent.change(input, { target: { value: "draft prompt" } });
  fireEvent.click(screen.getByTestId("prompt-item-systemReminder"));
  await screen.findByTestId("mcp-prompt-systemReminder-input");
  fireEvent.click(screen.getByTestId("prompt-item-systemPrompt"));
  expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBe(input);
  expect(input).toHaveValue("draft prompt");
  await waitFor(() => expect(screen.getByTestId("mcp-prompt-systemPrompt-save")).toBeEnabled());
  fireEvent.click(screen.getByTestId("mcp-prompt-systemPrompt-save"));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId("mcp-prompt-systemPrompt-save")).toBeEnabled());
  expect(input).toHaveValue("draft prompt");
});

test("admin navigation preserves query parameters and the mounted values draft without user tour anchors", async () => {
  let storedEnabled = "false";
  jest.spyOn(apiClient, "getGlobalSettings").mockImplementation(async () => ({
    settings: [row("probe.text", "text", "stored"), row("probe.enabled", "boolean", storedEnabled)],
    grouped: {},
  }));
  jest.spyOn(apiClient, "getSettingDefinitions").mockResolvedValue([]);
  function Location() {
    return <output aria-label="Location">{useLocation().search}</output>;
  }
  show(
    <MemoryRouter initialEntries={["/admin/settings?tab=values&keep=yes"]}>
      <AdminSettingsUnified />
      <Location />
    </MemoryRouter>,
  );
  await expandCategory();
  expect(apiClient.getGlobalSettings).toHaveBeenCalledTimes(1);
  const input = screen.getByTestId("setting-probe.text-input");
  fireEvent.change(input, { target: { value: "values draft" } });
  fireEvent.click(screen.getByTestId("admin-settings-nav-definitions"));
  expect(screen.getByLabelText("Location")).toHaveTextContent("tab=definitions&keep=yes");
  expect(input).not.toBeVisible();
  storedEnabled = "true";
  fireEvent.click(screen.getByTestId("admin-settings-nav-values"));
  await waitFor(() => expect(screen.getByTestId("setting-probe.enabled-input")).toBeChecked());
  expect(apiClient.getGlobalSettings).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("setting-probe.text-input")).toBe(input);
  expect(input).toBeVisible();
  expect(input).toHaveValue("values draft");
  expect(document.querySelector('[data-guide="settings.nav"]')).toBeNull();
});

test("returning to an untouched prompt reads its changed source without an initial duplicate request", async () => {
  let stored = "original";
  const read = jest.fn(async (type: "systemPrompt" | "systemReminder") => ({
    key: `mcp.${type}`,
    value: type === "systemPrompt" ? stored : "reminder",
  }));
  show(<McpPromptsEditor onFetchValue={read} onSave={async () => {}} onReset={async () => {}} />);
  const input = await screen.findByTestId("mcp-prompt-systemPrompt-input");
  expect(input).toHaveValue("original");
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("prompt-item-systemReminder"));
  await screen.findByTestId("mcp-prompt-systemReminder-input");
  stored = "updated elsewhere";
  fireEvent.click(screen.getByTestId("prompt-item-systemPrompt"));
  await waitFor(() => expect(input).toHaveValue("updated elsewhere"));
  expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBe(input);
});

test("the global-settings alias still opens values without an explicit tab", async () => {
  jest.spyOn(apiClient, "getGlobalSettings").mockResolvedValue({ settings: [], grouped: {} });
  show(
    <MemoryRouter initialEntries={["/admin/global-settings"]}>
      <AdminSettingsUnified defaultTab="values" />
    </MemoryRouter>,
  );
  expect(await screen.findByTestId("tab-values")).toBeVisible();
  expect(screen.getByTestId("admin-settings-nav-values")).toHaveAttribute(
    "aria-current",
    "location",
  );
});

const controls: Awaited<ReturnType<typeof apiClient.getAdminCodespaces>> = {
  controls: [{ scope: "global", disabled: false, reason: null, updated_at: null }],
  readiness: {
    state: "ready",
    reason: null,
    provider: "github-codespaces",
    configuration: "available",
    resources_enabled: true,
    controls: [{ scope: "global", disabled: false, reason: null, updated_at: null }],
    connector: { state: "available", reason: null },
    reconciliation: { due_resources: 0, due_operations: 0, oldest_due_age_ms: null },
    usage: {
      active_resources: 0,
      max_active_resources: 4,
      active_operations: 0,
      max_active_operations: 20,
      transfer_live_bytes: 0,
      max_transfer_live_bytes: 1024,
    },
    checked_at: 1,
  },
};

function twoControls(disabled: boolean): typeof controls {
  const rows = (["global", "provider:github-codespaces"] as const).map((scope) => ({
    scope,
    disabled,
    reason: null,
    updated_at: null,
  }));
  return { controls: rows, readiness: { ...controls.readiness, controls: rows } };
}

test("reversed independent codespace mutation responses reread authority without reverting a neighbour or its new draft", async () => {
  const first = deferred<typeof controls>();
  const second = deferred<typeof controls>();
  const accepted = twoControls(false);
  const staleFirst = twoControls(true);
  staleFirst.controls[0]!.disabled = false;
  const get = jest
    .spyOn(apiClient, "getAdminCodespaces")
    .mockResolvedValueOnce(twoControls(true))
    .mockResolvedValue(accepted);
  jest
    .spyOn(apiClient, "setAdminCodespaceControl")
    .mockImplementation((scope) => (scope === "global" ? first.promise : second.promise));
  show(<AdminCodespaceControls />);
  await screen.findByTestId("admin-codespace-enable-global");
  const neighbour = screen.getByTestId("admin-codespace-control-provider-github-codespaces");
  const input = within(neighbour).getByRole("textbox");
  fireEvent.click(screen.getByTestId("admin-codespace-enable-global"));
  expect(screen.getByTestId("admin-codespace-enable-provider-github-codespaces")).toBeEnabled();
  fireEvent.click(screen.getByTestId("admin-codespace-enable-provider-github-codespaces"));
  fireEvent.change(input, { target: { value: "new neighbour draft" } });
  input.focus();
  await act(async () => second.resolve(accepted));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("admin-codespace-disable-global")).toBeDisabled();
  expect(screen.getByTestId("admin-codespace-disable-provider-github-codespaces")).toBeEnabled();
  await act(async () => first.resolve(staleFirst));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  expect(
    screen.getByTestId("admin-codespace-control-state-provider-github-codespaces"),
  ).toHaveTextContent(i18n.t("admin.codespaces.accepting"));
  expect(screen.getByTestId("admin-codespace-disable-global")).toBeEnabled();
  expect(within(neighbour).getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("new neighbour draft");
  expect(input).toHaveFocus();
});

test.each(["owner", "unmount", "suspend"] as const)(
  "late codespace mutation after %s produces no global toast",
  async (retirement) => {
    observeReadSession("settings-admin", "settings-session");
    const next = deferred<typeof controls>();
    const get = jest.spyOn(apiClient, "getAdminCodespaces").mockResolvedValue(twoControls(true));
    jest.spyOn(apiClient, "setAdminCodespaceControl").mockImplementation(() => next.promise);
    const success = jest.spyOn(toast, "success");
    const error = jest.spyOn(toast, "error");
    const view = show(<AdminCodespaceControls />);
    fireEvent.click(await screen.findByTestId("admin-codespace-enable-global"));
    if (retirement === "owner") observeReadSession("replacement-admin", "replacement-session");
    else if (retirement === "unmount") view.unmount();
    else suspendReadSession();
    await act(async () => next.resolve(twoControls(false)));
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    if (retirement !== "suspend") expect(get).toHaveBeenCalledTimes(1);
    observeReadSession(null, null);
  },
);

test("codespace refresh retains the reason field and its draft through failure and retry", async () => {
  const next = deferred<typeof controls>();
  jest
    .spyOn(apiClient, "getAdminCodespaces")
    .mockResolvedValueOnce(controls)
    .mockImplementationOnce(() => next.promise)
    .mockResolvedValue(controls);
  show(<AdminCodespaceControls />);
  await screen.findByTestId("admin-codespace-control-global");
  const input = screen.getByLabelText(i18n.t("admin.codespaces.reasonLabel"));
  fireEvent.change(input, { target: { value: "planned maintenance" } });
  input.focus();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.codespaces.refresh") }));
  expect(screen.getByLabelText(i18n.t("admin.codespaces.reasonLabel"))).toBe(input);
  expect(input).toHaveFocus();
  await act(async () => next.reject(new Error("unavailable")));
  expect(input).toHaveValue("planned maintenance");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dataRegion.retry") }));
  await waitFor(() => expect(apiClient.getAdminCodespaces).toHaveBeenCalledTimes(3));
  expect(input).toHaveValue("planned maintenance");
});

test("a refused prompt read is an error with retry rather than an empty editable value", async () => {
  jest
    .spyOn(apiClient, "getGlobalSettings")
    .mockResolvedValue({ settings: [row("probe.text", "text", "saved")], grouped: {} });
  jest
    .mocked(apiClient.getMcpPromptScopeValue)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({
      key: "mcp.systemPrompt",
      value: "real prompt",
      exists: true,
      scope: "default",
    });
  show(<AdminSettings embedded />);
  expect(await screen.findByText(i18n.t("admin.settingsRegions.loadFailed"))).toBeInTheDocument();
  expect(screen.queryByTestId("mcp-prompt-systemPrompt-input")).toBeNull();
  expect(screen.getByTestId("export-settings")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dataRegion.retry") }));
  expect(await screen.findByTestId("mcp-prompt-systemPrompt-input")).toHaveValue("real prompt");
});

test("a global setting category is keyboard focusable and exposes its expansion state", async () => {
  jest
    .spyOn(apiClient, "getGlobalSettings")
    .mockResolvedValue({ settings: [row("probe.text", "text", null)], grouped: {} });
  show(<AdminSettings embedded />);
  const category = await screen.findByRole("button", {
    name: new RegExp(i18n.t("admin.settingsRegions.systemCategory"), "i"),
  });
  category.focus();
  expect(category).toHaveFocus();
  expect(category).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(category);
  expect(category).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("setting-probe.text-input")).toHaveValue("");
});

test("a failed history read keeps the prompt draft and does not claim an empty successful history", async () => {
  const history = deferred<[]>();
  show(
    <McpPromptsEditor
      onFetchValue={async () => ({ key: "mcp.systemPrompt", value: "stored" })}
      onSave={async () => {}}
      onReset={async () => {}}
      onFetchHistory={() => history.promise}
    />,
  );
  const input = await screen.findByTestId("mcp-prompt-systemPrompt-input");
  fireEvent.change(input, { target: { value: "draft remains" } });
  fireEvent.click(screen.getByTestId("mcp-prompt-systemPrompt-history"));
  input.focus();
  expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBe(input);
  await act(async () => history.reject(new Error("unavailable")));
  expect(await screen.findByText(i18n.t("admin.settingsRegions.loadFailed"))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("admin.mcpPrompts.history.noEntries"))).toBeNull();
  expect(input).toHaveFocus();
  expect(input).toHaveValue("draft remains");
});
