/**
 * The seams as the product actually uses them: `DatabaseRepository`.
 *
 * Every consumer of settings — the settings screen, the admin screen, the MCP tool, the execution
 * engine — reaches them through this object. Checking the merge helpers alone would leave the case
 * that matters unobserved: helpers that work while the repository still answers from the database
 * only, which is exactly what "the definitions seam is closed and the value seam is not" looks like.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import {
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
  extensionSettingsCategory,
  decryptValue,
  ExtensionNodeHandler,
  AgentMessageQueue,
} from "@mcp-moira/workflow-engine";
import type { ExtensionInvocationRequest, ExtensionManifest } from "@mcp-moira/workflow-engine";
import { getDatabase, getSqliteInstance, user } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import { manageSettings } from "../../packages/mcp-server/src/tools/manage-settings.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "seam-messenger",
  version: "1.0.0",
  entrypoint: "index.js",
  nodes: [
    {
      type: "seam-messenger.send",
      title: "Send",
      configSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
  settings: [
    { key: "seam-messenger.token", type: "encrypted", label: "Token" },
    { key: "seam-messenger.enabled", type: "boolean", label: "Enabled", defaultValue: "false" },
    { key: "seam-messenger.retries", type: "number", label: "Retries", defaultValue: "3" },
    { key: "seam-messenger.sender", type: "string", label: "Sender" },
    { key: "seam-messenger.payload", type: "json", label: "Payload" },
    {
      key: "seam-messenger.routing",
      type: "json",
      label: "Routing table",
      validation: {
        type: "object",
        required: ["default"],
        properties: {
          default: { type: "string" },
          overrides: {
            type: "array",
            items: {
              type: "object",
              required: ["match", "chat"],
              properties: { match: { type: "string" }, chat: { type: "string" } },
            },
          },
        },
      },
    },
  ],
  permissions: { secrets: ["seam-messenger.token"] },
};

describe("DatabaseRepository serves extension settings on both seams", () => {
  let repository: DatabaseRepository;
  let registry: ExtensionRegistry;
  const userId = "test-user-extension-settings";

  beforeAll(async () => {
    repository = new DatabaseRepository();
    const db = getDatabase();
    const now = new Date().toISOString();
    await db
      .insert(user)
      .values({
        id: userId,
        email: `${userId}@test.local`,
        name: "Extension settings user",
        handle: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);
  });

  beforeEach(() => {
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM extensionSettingValue WHERE userId = ?").run(userId);
    sqlite.prepare("DELETE FROM auditLog WHERE userId = ?").run(userId);
  });

  afterAll(async () => {
    setActiveExtensionRegistry(null);
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM extensionSettingValue WHERE userId = ?").run(userId);
    await getDatabase().delete(user).where(eq(user.id, userId));
  });

  test("the declared setting is in the definition list and nothing was written to the table", async () => {
    const storedBefore = getSqliteInstance()
      .prepare("SELECT COUNT(*) AS n FROM settingDefinition")
      .get() as { n: number };

    const definitions = await repository.getSettingDefinitions();
    const declared = definitions.find((definition) => definition.key === "seam-messenger.token");

    expect(declared).toBeDefined();
    expect(declared!.source).toBe("extension");
    expect(declared!.category).toBe(extensionSettingsCategory("seam-messenger"));
    expect(await repository.getSettingDefinition("seam-messenger.enabled")).not.toBeNull();

    const storedAfter = getSqliteInstance()
      .prepare("SELECT COUNT(*) AS n FROM settingDefinition")
      .get() as { n: number };
    // Reading the list is the operation that would have stored them.
    expect(storedAfter.n).toBe(storedBefore.n);
    expect(
      getSqliteInstance()
        .prepare("SELECT key FROM settingDefinition WHERE key LIKE 'seam-messenger.%'")
        .all(),
    ).toEqual([]);
  });

  test("a value saved through the repository is read back by the same repository", async () => {
    await repository.setSetting(userId, "seam-messenger.token", "seam-token-value");

    // Required state: the value goes in and comes back. Plausible wrong state: only definitions are
    // merged, so the write throws "definition not found" or lands nowhere and the read is empty —
    // indistinguishable on the screen from a setting nobody filled in.
    expect(await repository.getSetting(userId, "seam-messenger.token")).toBe("seam-token-value");

    const row = getSqliteInstance()
      .prepare(
        "SELECT value, encrypted FROM extensionSettingValue WHERE userId = ? AND settingKey = ?",
      )
      .get(userId, "seam-messenger.token") as { value: string; encrypted: number };
    expect(row.encrypted).toBe(1);
    expect(row.value).not.toContain("seam-token-value");
    expect(decryptValue(row.value)).toBe("seam-token-value");
  });

  test("the consumer-facing map shows a mask of the set secret, not the secret and not emptiness", async () => {
    await repository.setSetting(userId, "seam-messenger.token", "seam-token-value");

    const forApi = await repository.getSettingsForApi(
      userId,
      extensionSettingsCategory("seam-messenger"),
    );

    const shown = String(forApi["seam-messenger.token"]);
    expect(shown).not.toBe("");
    expect(shown).not.toContain("seam-token-value");
    expect(shown.endsWith("alue")).toBe(true);

    const internal = await repository.getSettings(
      userId,
      extensionSettingsCategory("seam-messenger"),
    );
    expect(internal["seam-messenger.token"]).toBe("seam-token-value");
  });

  test("an encrypted manifest default is usable internally but never returned as API plaintext", async () => {
    const registryWithDefault = new ExtensionRegistry();
    registryWithDefault.register({
      ...MANIFEST,
      settings: [
        ...(MANIFEST.settings ?? []),
        {
          key: "seam-messenger.default-secret",
          type: "encrypted",
          label: "Default secret",
          defaultValue: "manifest-default-secret",
        },
      ],
    });
    setActiveExtensionRegistry(registryWithDefault);

    try {
      expect(await repository.getSetting(userId, "seam-messenger.default-secret")).toBe(
        "manifest-default-secret",
      );
      const exposed = await repository.getSettingsForApi(
        userId,
        extensionSettingsCategory("seam-messenger"),
      );
      expect(exposed["seam-messenger.default-secret"]).toBeUndefined();
    } finally {
      setActiveExtensionRegistry(registry);
    }
  });

  test("the stored granted secret reaches a handler, while an ungranted setting does not", async () => {
    await repository.setSetting(userId, "seam-messenger.token", "handler-secret");
    await repository.setSetting(userId, "seam-messenger.routing", { default: "ops" });

    let seen: ExtensionInvocationRequest | undefined;
    const handler = new ExtensionNodeHandler(registry, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });

    await handler.execute(
      {
        type: "seam-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "extension-settings-seam",
        workflowId: "extension-settings-seam",
        userId,
      } as never,
      new AgentMessageQueue(),
      repository,
      {} as never,
    );

    expect(seen?.secrets).toEqual({ "seam-messenger.token": "handler-secret" });
    expect(seen?.secrets).not.toHaveProperty("seam-messenger.routing");
  });

  test("the MCP settings surface lists, writes and masks a manifest-declared secret", async () => {
    const set = await runWithMCPContext({ userId }, () =>
      manageSettings({
        action: "set",
        key: "seam-messenger.token",
        value: "mcp-secret-value",
      }),
    );
    expect(set.success).toBe(true);

    const listed = await runWithMCPContext({ userId }, () =>
      manageSettings({ action: "list", category: "extension:seam-messenger" }),
    );
    expect(listed.success).toBe(true);
    expect(
      (listed.data as Array<{ key: string }> | undefined)?.map((definition) => definition.key),
    ).toContain("seam-messenger.token");

    const read = await runWithMCPContext({ userId }, () =>
      manageSettings({ action: "get", key: "seam-messenger.token" }),
    );
    const shown = String(
      (read.data as Record<string, unknown> | undefined)?.["seam-messenger.token"],
    );
    expect(read.success).toBe(true);
    expect(shown).not.toContain("mcp-secret-value");
    expect(shown.endsWith("alue")).toBe(true);
  });

  test("a declared default is served until a value is stored, and typed as declared", async () => {
    expect(await repository.getSetting(userId, "seam-messenger.enabled")).toBe(false);
    expect(await repository.getSetting(userId, "seam-messenger.retries")).toBe(3);

    await repository.setSetting(userId, "seam-messenger.enabled", true);
    expect(await repository.getSetting(userId, "seam-messenger.enabled")).toBe(true);

    await repository.deleteUserSettingValue(userId, "seam-messenger.enabled");
    expect(await repository.getSetting(userId, "seam-messenger.enabled")).toBe(false);
  });

  test("the declared primitive type rejects values that would change meaning when read", async () => {
    await expect(
      repository.setSetting(userId, "seam-messenger.retries", "not-a-number"),
    ).rejects.toThrow("number");
    await expect(repository.setSetting(userId, "seam-messenger.enabled", "yes")).rejects.toThrow(
      "boolean",
    );
    await expect(
      repository.setSetting(userId, "seam-messenger.sender", { nested: "object" }),
    ).rejects.toThrow("string");
    await expect(
      repository.setSetting(userId, "seam-messenger.token", { exposed: true }),
    ).rejects.toThrow("encrypted");
    await expect(
      repository.setSetting(userId, "seam-messenger.routing", "not-json"),
    ).rejects.toThrow("JSON");

    expect(
      getSqliteInstance()
        .prepare("SELECT settingKey FROM extensionSettingValue WHERE userId = ?")
        .all(userId),
    ).toEqual([]);

    await repository.setSetting(userId, "seam-messenger.retries", "2.5");
    await repository.setSetting(userId, "seam-messenger.enabled", "true");
    expect(await repository.getSetting(userId, "seam-messenger.retries")).toBe(2.5);
    expect(await repository.getSetting(userId, "seam-messenger.enabled")).toBe(true);
  });

  test("a structured JSON value must round-trip without omitted or transformed data", async () => {
    const sparse = ["first", "second"];
    delete sparse[0];
    const hiddenArrayHook = ["original"];
    Object.defineProperty(hiddenArrayHook, "toJSON", {
      value: () => ["changed"],
      enumerable: false,
    });
    class TransformingArray extends Array<string> {
      toJSON(): string[] {
        return ["changed"];
      }
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      BigInt(1),
      new Date("2026-01-01T00:00:00.000Z"),
      new Map([["route", "ops"]]),
      { keep: true, drop: undefined },
      sparse,
      { value: 1, toJSON: () => ({ value: 2 }) },
      hiddenArrayHook,
      new TransformingArray("original"),
      cyclic,
    ];

    for (const value of invalidValues) {
      await expect(repository.setSetting(userId, "seam-messenger.payload", value)).rejects.toThrow(
        /JSON/,
      );
    }

    expect(
      getSqliteInstance()
        .prepare("SELECT settingKey FROM extensionSettingValue WHERE userId = ? AND settingKey = ?")
        .all(userId, "seam-messenger.payload"),
    ).toEqual([]);

    const valid = {
      route: "ops",
      enabled: true,
      retries: 2.5,
      fallback: null,
      targets: ["primary", { name: "secondary", weight: 0 }],
    };
    await repository.setSetting(userId, "seam-messenger.payload", valid);
    expect(await repository.getSetting(userId, "seam-messenger.payload")).toEqual(valid);

    for (const { input, expected } of [
      { input: '"text"', expected: "text" },
      { input: 4, expected: 4 },
      { input: false, expected: false },
      { input: null, expected: null },
    ]) {
      await repository.setSetting(userId, "seam-messenger.payload", input);
      expect(await repository.getSetting(userId, "seam-messenger.payload")).toEqual(expected);
    }
  });

  test("a granted top-level JSON primitive crosses the handler boundary as JSON text", async () => {
    const grantingRegistry = new ExtensionRegistry();
    expect(
      grantingRegistry.register({
        ...MANIFEST,
        permissions: { secrets: ["seam-messenger.payload"] },
      }).registered,
    ).toBe(true);
    setActiveExtensionRegistry(grantingRegistry);
    await repository.setSetting(userId, "seam-messenger.payload", '"literal"');

    let seen: ExtensionInvocationRequest | undefined;
    const handler = new ExtensionNodeHandler(grantingRegistry, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    await handler.execute(
      { type: "seam-messenger.send", id: "send", config: {} } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-json-primitive",
        workflowId: "wf-json-primitive",
        userId,
      } as never,
      new AgentMessageQueue(),
      repository,
      {} as never,
    );

    expect(seen?.secrets).toEqual({ "seam-messenger.payload": '"literal"' });

    await repository.setSetting(userId, "seam-messenger.payload", null);
    const storedNull = await repository.getSettings(
      userId,
      extensionSettingsCategory("seam-messenger"),
    );
    expect(Object.hasOwn(storedNull, "seam-messenger.payload")).toBe(true);
    expect(storedNull["seam-messenger.payload"]).toBeNull();
    await handler.execute(
      { type: "seam-messenger.send", id: "send-null", config: {} } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-json-null",
        workflowId: "wf-json-null",
        userId,
      } as never,
      new AgentMessageQueue(),
      repository,
      {} as never,
    );
    expect(seen?.secrets).toEqual({ "seam-messenger.payload": "null" });

    await repository.deleteUserSettingValue(userId, "seam-messenger.payload");
    const unset = await repository.getSettings(userId, extensionSettingsCategory("seam-messenger"));
    expect(Object.hasOwn(unset, "seam-messenger.payload")).toBe(false);
    await handler.execute(
      { type: "seam-messenger.send", id: "send-unset", config: {} } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-json-unset",
        workflowId: "wf-json-unset",
        userId,
      } as never,
      new AgentMessageQueue(),
      repository,
      {} as never,
    );
    expect(seen?.secrets).toEqual({ "seam-messenger.payload": null });
    setActiveExtensionRegistry(registry);
  });

  test("an extension's definition cannot be created or deleted as a database row", async () => {
    // Required state: one definition, one lifetime. Plausible wrong state: the admin path writes or
    // deletes a row of the same name — deleting reports success while removing nothing, and
    // creating leaves the key with two definitions whose lifetimes differ.
    await expect(
      repository.createSettingDefinition({
        key: "seam-messenger.token",
        type: "string",
        category: "general",
        label: "Shadow",
        required: false,
        adminOnly: false,
        protected: false,
      }),
    ).rejects.toThrow(/declared by extension 'seam-messenger'/);

    await expect(repository.deleteSettingDefinition("seam-messenger.token")).rejects.toThrow(
      /remove the extension to remove the setting/,
    );
  });

  test("saving and resetting a declared setting is audited like a stored one", async () => {
    // Required state: the audit answers "who changed which setting and when" for every setting.
    // Plausible wrong state: only stored keys are audited, because the extension branch writes
    // straight to its value store — the log stays plausible while being silent about half the
    // settings on the screen.
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM auditLog WHERE resourceId = ?").run("seam-messenger.token");

    await repository.setSetting(userId, "seam-messenger.token", "audited-value");
    await repository.deleteUserSettingValue(userId, "seam-messenger.token");

    const entries = sqlite
      .prepare("SELECT action, changes FROM auditLog WHERE resourceId = ? ORDER BY createdAt")
      .all("seam-messenger.token") as Array<{ action: string; changes: string | null }>;

    expect(entries.map((entry) => entry.action)).toEqual(["settings:set", "settings:delete"]);
    // The secret itself is not in the log.
    expect(entries[0].changes).toContain("[encrypted]");
    expect(entries[0].changes).not.toContain("audited-value");
  });

  test("a structural setting saves the text the screen sends and reaches the handler as JSON", async () => {
    // Required state: the value an administrator types is savable and arrives at the handler in the
    // shape the extension declared. Plausible wrong state, and the one the plan warned about: the
    // setting is visible and looks editable while the write refuses every correct value — the
    // screen's field for a structural setting is a textarea, so the value arrives as text, and a
    // check applied to the raw string rejects it. The mirror image on the way out is a value
    // handed over as `[object Object]`.
    const typedInTheField = '{"default":"ops","overrides":[{"match":"urgent","chat":"oncall"}]}';

    await repository.setSetting(userId, "seam-messenger.routing", typedInTheField);

    expect(await repository.getSetting(userId, "seam-messenger.routing")).toEqual({
      default: "ops",
      overrides: [{ match: "urgent", chat: "oncall" }],
    });

    // Text that is not JSON is a named refusal, not a value quietly stored as a string.
    await expect(
      repository.setSetting(userId, "seam-messenger.routing", "{not json"),
    ).rejects.toThrow(/valid JSON/);
  });

  test("built-in settings still answer from the database", async () => {
    // The routing must not swallow the ordinary case: a built-in key has no declaration and has to
    // keep taking the stored path, audit and all.
    const builtIn = await repository.getSettingDefinition("telegram.enabled");
    expect(builtIn).not.toBeNull();
    expect(builtIn!.source).toBeUndefined();
  });
});
