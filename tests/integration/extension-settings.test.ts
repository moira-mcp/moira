/**
 * Settings declared by an extension manifest, from the screen's path to the handler's.
 *
 * Two failures this guards against look identical from outside and are the reason the observations
 * below are shaped as they are:
 *  - the definitions quietly settle in the database on first load. The screen looks right, and the
 *    difference shows only after the bundle is removed — so the definitions table is snapshotted.
 *  - only the definition seam is closed: the setting appears, looks editable, and the value is
 *    refused on the way in or comes back empty on the way out, which reads exactly like "the
 *    administrator has not filled it in yet" — so the value is followed all the way through.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@mcp-moira/shared";
import { ExtensionSettingsRepository } from "@mcp-moira/shared";
import {
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  validateExtensionManifest,
  setActiveExtensionRegistry,
  extensionSettingDefinitions,
  extensionSettingDefinition,
  mergeSettingDefinitions,
  validateExtensionSettingValue,
  extensionSettingsCategory,
  decryptValue,
  maskEncryptedValue,
} from "@mcp-moira/workflow-engine";
import { ExtensionNodeHandler, AgentMessageQueue } from "@mcp-moira/workflow-engine";
import type {
  ExtensionManifest,
  ExtensionInvocationRequest,
  SettingDefinition,
} from "@mcp-moira/workflow-engine";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "1.0.0",
  entrypoint: "index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send",
      configSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
  settings: [
    {
      key: "corporate-messenger.token",
      type: "encrypted",
      label: "Bot token",
      description: "Token issued by the messenger",
    },
    {
      key: "corporate-messenger.routing",
      type: "json",
      label: "Routing table",
      // A structural setting: only a real schema check can tell a valid routing table from a
      // plausible-looking object.
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
        additionalProperties: false,
      },
    },
  ],
  permissions: { secrets: ["corporate-messenger.token"] },
};

/** The database as an installation has it: the built-in tables plus the extension value store. */
function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE settingDefinition (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      defaultValue TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      validation TEXT,
      adminOnly INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE extensionSettingValue (
      userId TEXT NOT NULL,
      settingKey TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (userId, settingKey)
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO settingDefinition (key, type, category, label, required, adminOnly, protected, createdAt, updatedAt)
       VALUES ('telegram.bot_token', 'encrypted', 'notifications', 'Bot token', 0, 0, 1, 0, 0)`,
    )
    .run();
  return sqlite;
}

function storedDefinitions(sqlite: ReturnType<typeof Database>): string[] {
  return (
    sqlite.prepare("SELECT key FROM settingDefinition ORDER BY key").all() as Array<{
      key: string;
    }>
  ).map((row) => row.key);
}

describe("Extension settings: definitions come from the manifest and stay there", () => {
  let sqlite: ReturnType<typeof Database>;
  let registry: ExtensionRegistry;

  beforeEach(() => {
    sqlite = createDatabase();
    registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);
  });

  afterEach(() => {
    setActiveExtensionRegistry(null);
    sqlite.close();
  });

  test("declared settings join the built-in list without a row appearing in the database", () => {
    const before = storedDefinitions(sqlite);

    const stored: SettingDefinition[] = [
      {
        key: "telegram.bot_token",
        type: "encrypted",
        category: "notifications",
        label: "Bot token",
        required: false,
        adminOnly: false,
        protected: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const merged = mergeSettingDefinitions(stored, registry);

    expect(merged.map((definition) => definition.key)).toEqual([
      "telegram.bot_token",
      "corporate-messenger.token",
      "corporate-messenger.routing",
    ]);
    // The distinguishing part: reading the list is exactly the operation that would have stored
    // them, and the table is unchanged afterwards.
    expect(storedDefinitions(sqlite)).toEqual(before);

    const declared = merged.find((d) => d.key === "corporate-messenger.token")!;
    expect(declared.source).toBe("extension");
    expect(declared.extensionName).toBe("corporate-messenger");
    expect(declared.category).toBe(extensionSettingsCategory("corporate-messenger"));
  });

  test("when a stored row and a declaration collide, the declaration describes the setting", () => {
    // The collision is narrow but reachable: a row created before the extension was installed.
    // Required state: definition and value come from the same place. Plausible wrong state: the
    // list describes the stored row while the value paths use the declaration, producing a setting
    // that shows one type and saves as another.
    const stored: SettingDefinition[] = [
      {
        key: "corporate-messenger.token",
        type: "string",
        category: "general",
        label: "Older stored row",
        required: false,
        adminOnly: false,
        protected: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    const merged = mergeSettingDefinitions(stored, registry);
    const shown = merged.filter((d) => d.key === "corporate-messenger.token");

    expect(shown).toHaveLength(1);
    expect(shown[0].source).toBe("extension");
    expect(shown[0].type).toBe("encrypted");
  });

  test("removing the bundle removes the definitions and keeps the values", async () => {
    const values = new ExtensionSettingsRepository(drizzle(sqlite, { schema }));
    await values.setValue("user-1", "corporate-messenger.token", "t-42", true);

    // The extension goes away exactly as it does on disk: the registry no longer holds it.
    registry.unregister("corporate-messenger");

    expect(extensionSettingDefinitions(registry)).toEqual([]);
    expect(extensionSettingDefinition("corporate-messenger.token", registry)).toBeNull();
    // Required state: an administrator's work survives reinstalling the bundle. Plausible wrong
    // state: values are cleaned up with the definitions and the form comes back empty.
    expect(await values.getValue("user-1", "corporate-messenger.token")).toBe("t-42");
  });

  test("a manifest is rejected when a default cannot satisfy its declared setting type", () => {
    const invalidDefaults: Array<{ type: "number" | "boolean" | "json"; value: string }> = [
      { type: "number", value: "not-a-number" },
      { type: "boolean", value: "yes" },
      { type: "json", value: "{" },
    ];

    for (const { type, value } of invalidDefaults) {
      const rejection = validateExtensionManifest({
        ...MANIFEST,
        permissions: undefined,
        settings: [
          {
            key: `corporate-messenger.${type}`,
            type,
            label: type,
            defaultValue: value,
          },
        ],
      });

      expect(rejection?.reasons.join("\n")).toContain("defaultValue");
      expect(rejection?.reasons.join("\n")).toContain(type === "json" ? "JSON" : type);
    }
  });

  test("a manifest default must also satisfy its optional validation schema", () => {
    const rejection = validateExtensionManifest({
      ...MANIFEST,
      permissions: undefined,
      settings: [
        {
          key: "corporate-messenger.retries",
          type: "number",
          label: "Retries",
          defaultValue: "2",
          validation: { type: "number", minimum: 3 },
        },
      ],
    });

    expect(rejection?.reasons.join("\n")).toContain("defaultValue");
    expect(rejection?.reasons.join("\n")).toContain(">= 3");
  });
});

describe("Extension setting values", () => {
  let sqlite: ReturnType<typeof Database>;
  let values: ExtensionSettingsRepository;

  beforeEach(() => {
    sqlite = createDatabase();
    values = new ExtensionSettingsRepository(drizzle(sqlite, { schema }));
  });

  afterEach(() => {
    sqlite.close();
  });

  test("a secret is stored as ciphertext and read back as itself", async () => {
    await values.setValue("user-1", "corporate-messenger.token", "super-secret-token", true);

    const [row] = sqlite
      .prepare("SELECT value, encrypted FROM extensionSettingValue WHERE settingKey = ?")
      .all("corporate-messenger.token") as Array<{ value: string; encrypted: number }>;

    // Required state: at rest it is ciphertext. Plausible wrong state: the value is stored in the
    // clear and only the screen draws asterisks — an observation that "the response has no secret"
    // would pass in both cases, so the stored bytes are looked at directly.
    expect(row.encrypted).toBe(1);
    expect(row.value).not.toContain("super-secret-token");
    expect(decryptValue(row.value)).toBe("super-secret-token");
    expect(await values.getValue("user-1", "corporate-messenger.token")).toBe("super-secret-token");

    // And the mask of a set value is neither the value nor emptiness.
    const mask = maskEncryptedValue(row.value);
    expect(mask).not.toBe("");
    expect(mask).not.toContain("super-secret-token");
    expect(mask.endsWith("oken")).toBe(true);
  });

  test("values are per user and a stored value replaces the previous one", async () => {
    await values.setValue("user-1", "corporate-messenger.routing", '{"default":"a"}', false);
    await values.setValue("user-2", "corporate-messenger.routing", '{"default":"b"}', false);
    await values.setValue("user-1", "corporate-messenger.routing", '{"default":"c"}', false);

    expect(await values.getValue("user-1", "corporate-messenger.routing")).toBe('{"default":"c"}');
    expect(await values.getValue("user-2", "corporate-messenger.routing")).toBe('{"default":"b"}');
    expect(await values.listValues("user-1")).toHaveLength(1);
  });

  test("a deleted value returns nothing, which is how an unset setting reads", async () => {
    await values.setValue("user-1", "corporate-messenger.token", "t", true);
    await values.deleteValue("user-1", "corporate-messenger.token");

    expect(await values.getValue("user-1", "corporate-messenger.token")).toBeNull();
    expect(await values.getRawValue("user-1", "corporate-messenger.token")).toBeNull();
  });
});

describe("A structural setting is checked against its own schema", () => {
  const definition = () => {
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    return extensionSettingDefinition("corporate-messenger.routing", registry)!;
  };

  test("a value matching the declared schema is accepted", () => {
    expect(
      validateExtensionSettingValue(definition(), {
        default: "general",
        overrides: [{ match: "urgent", chat: "ops" }],
      }),
    ).toBeNull();
  });

  test("a plausible but wrong value is refused with the offending path named", () => {
    // Required state: the whole schema is applied. Plausible wrong state: only familiar keywords
    // (`type`, `enum`, lengths) are checked, which accepts any object at all — including this one.
    const problems = validateExtensionSettingValue(definition(), {
      default: "general",
      overrides: [{ match: "urgent" }],
    });

    expect(problems).toBeTruthy();
    expect(problems).toContain("chat");
  });

  test("an upgraded extension is validated by its new schema, not the previous one", () => {
    // Required state: the schema in force is the one currently declared. Plausible wrong state: the
    // compiled validator is cached by setting key, and a new version of the extension — which
    // replaces declarations under the same keys — keeps being checked by the schema of the version
    // that was removed.
    const firstRegistry = new ExtensionRegistry();
    firstRegistry.register(MANIFEST);
    const firstDefinition = extensionSettingDefinition(
      "corporate-messenger.routing",
      firstRegistry,
    )!;
    expect(validateExtensionSettingValue(firstDefinition, { default: "general" })).toBeNull();

    const upgradedRegistry = new ExtensionRegistry();
    upgradedRegistry.register({
      ...MANIFEST,
      version: "2.0.0",
      settings: [
        // The token stays declared: the manifest grants it in `permissions.secrets`, and a grant
        // may only name a setting the same manifest declares.
        { key: "corporate-messenger.token", type: "encrypted", label: "Bot token" },
        {
          key: "corporate-messenger.routing",
          type: "json",
          label: "Routing table",
          // The new version demands a field the old one did not have.
          validation: {
            type: "object",
            required: ["default", "fallback"],
            properties: { default: { type: "string" }, fallback: { type: "string" } },
          },
        },
      ],
    });
    const upgraded = extensionSettingDefinition("corporate-messenger.routing", upgradedRegistry)!;

    const problems = validateExtensionSettingValue(upgraded, { default: "general" });
    expect(problems).toBeTruthy();
    expect(problems).toContain("fallback");
  });

  test("two settings whose schemas share an $id are both usable, one after the other", () => {
    // Required state: what the manifest check accepts, every consumer can compile. Plausible wrong
    // state: the check compiles on its own instance while the value path keeps a long-lived one
    // that registers each schema under its `$id`; the manifest is then accepted, the first value
    // saves, and the second — a different schema carrying the same `$id`, which two extensions or
    // two settings of one extension may easily do — throws `already exists` and leaves the endpoint
    // answering 500. The two states differ only on the second call, so both are made here.
    const sharedId = "https://example.test/shared-schema.json";
    const registry = new ExtensionRegistry();
    registry.register({
      ...MANIFEST,
      settings: [
        { key: "corporate-messenger.token", type: "encrypted", label: "Bot token" },
        {
          key: "corporate-messenger.routing",
          type: "json",
          label: "Routing table",
          validation: { $id: sharedId, type: "object", required: ["default"] },
        },
        {
          key: "corporate-messenger.fallback",
          type: "json",
          label: "Fallback table",
          validation: { $id: sharedId, type: "object", required: ["fallback"] },
        },
      ],
    });

    const routing = extensionSettingDefinition("corporate-messenger.routing", registry)!;
    const fallback = extensionSettingDefinition("corporate-messenger.fallback", registry)!;

    expect(validateExtensionSettingValue(routing, { default: "general" })).toBeNull();
    expect(validateExtensionSettingValue(fallback, { fallback: "ops" })).toBeNull();
    // Each schema is still the one its own declaration carries, not the first one compiled.
    expect(validateExtensionSettingValue(fallback, { default: "general" })).toContain("fallback");
  });

  test("a declaration whose schema cannot be compiled is a named refusal, not an exception", () => {
    // Manifest validation refuses such a schema at load, so this state is reached only by a
    // declaration that arrived another way — a registry snapshot from another Moira, a build with a
    // different Ajv. Required state: the value path still answers with a named problem. Plausible
    // wrong state: the compiler throws here, the exception travels up through `setSetting` to the
    // settings endpoint and the MCP tool, and an administrator sees Moira failing rather than the
    // bundle being wrong.
    const broken = { ...definition(), validation: JSON.stringify({ type: "banana" }) };

    let problems: string | null = null;
    expect(() => {
      problems = validateExtensionSettingValue(broken, { default: "general" });
    }).not.toThrow();
    expect(problems).toContain("not a usable JSON Schema");
  });

  test("an unexpected property is refused, since the declaration closed the object", () => {
    expect(
      validateExtensionSettingValue(definition(), { default: "general", unexpected: 1 }),
    ).toContain("unexpected");
  });
});

describe("The value an administrator saves is the value the handler receives", () => {
  /**
   * The two seams are followed in one observation on purpose. Closing only the definitions seam
   * produces a setting that is visible and editable while the value is refused on the way in or
   * comes back empty on the way out — which reads exactly like an unfilled setting.
   */
  let sqlite: ReturnType<typeof Database>;
  let registry: ExtensionRegistry;
  let repository: SettingsBackedRepository;

  /**
   * The part of `DatabaseRepository` this path uses, on a database of our own: the production class
   * takes the process-wide connection, which an integration test must not adopt. The routing rule
   * under test — a declared key goes to the extension store, a stored key to the ordinary one — is
   * the same code path shape, and the end-to-end assertion below is what makes it meaningful.
   */
  class SettingsBackedRepository {
    constructor(private readonly values: ExtensionSettingsRepository) {}

    async setSetting(userId: string, key: string, value: unknown): Promise<void> {
      const declared = extensionSettingDefinition(key);
      if (!declared) throw new Error(`not an extension setting: ${key}`);
      const problems = validateExtensionSettingValue(declared, value);
      if (problems) throw new Error(`invalid value for ${key}: ${problems}`);
      const serialised = typeof value === "object" ? JSON.stringify(value) : String(value);
      await this.values.setValue(userId, key, serialised, declared.type === "encrypted");
    }

    async getSetting<T>(userId: string, key: string): Promise<T | null> {
      const declared = extensionSettingDefinition(key);
      if (!declared) return null;
      const stored = await this.values.getValue(userId, key);
      if (stored === null) return null;
      return (declared.type === "json" ? JSON.parse(stored) : stored) as T;
    }
  }

  beforeEach(() => {
    sqlite = createDatabase();
    registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);
    repository = new SettingsBackedRepository(
      new ExtensionSettingsRepository(drizzle(sqlite, { schema })),
    );
  });

  afterEach(() => {
    setActiveExtensionRegistry(null);
    sqlite.close();
  });

  test("a granted alias reaches the handler with the saved value, an ungranted one is not sent", async () => {
    await repository.setSetting("user-1", "corporate-messenger.token", "saved-by-admin");

    const handler = new ExtensionNodeHandler(registry, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    let seen: ExtensionInvocationRequest | undefined;

    await handler.execute(
      {
        type: "corporate-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-1",
        workflowId: "wf-1",
        userId: "user-1",
      } as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    // The granted alias carries the very value that was saved through the write path above.
    expect(seen!.secrets).toEqual({ "corporate-messenger.token": "saved-by-admin" });
    // Not granted, therefore not sent: the runner refuses such an alias by name, and a value
    // delivered here would make that refusal unreachable.
    expect(Object.keys(seen!.secrets!)).not.toContain("corporate-messenger.routing");
  });

  test("two node types whose schemas share an $id are both executable by one handler", async () => {
    // Required state: what the manifest check accepts, the execution path can compile too. Plausible
    // wrong state: this handler keeps its own Ajv with Ajv's defaults — the way the code looked
    // before — so the first node type registers its schema under the shared `$id` and the second
    // dies on `already exists`. The setting-path observation stays green in that state, which is
    // why the same property is observed here, where a workflow actually runs.
    const sharedId = "https://example.test/node-schema.json";
    const twoNodes = new ExtensionRegistry();
    twoNodes.register({
      ...MANIFEST,
      nodes: [
        {
          type: "corporate-messenger.send",
          title: "Send",
          configSchema: { $id: sharedId, type: "object", required: ["chat"] },
          outputSchema: { type: "object" },
        },
        {
          type: "corporate-messenger.broadcast",
          title: "Broadcast",
          configSchema: { $id: sharedId, type: "object", required: ["audience"] },
          outputSchema: { type: "object" },
        },
      ],
    });
    setActiveExtensionRegistry(twoNodes);

    const invoked: string[] = [];
    const handler = new ExtensionNodeHandler(twoNodes, {
      async invoke(request) {
        invoked.push(request.nodeType);
        return { output: {} };
      },
    });

    const run = (type: string, config: Record<string, unknown>) =>
      handler.execute(
        { type, id: type, config, connections: { success: "end", error: "on-error" } } as never,
        {
          variables: {},
          nodeStates: {},
          executionId: "exec-1",
          workflowId: "wf-1",
          userId: "user-1",
        } as never,
        new AgentMessageQueue(),
        repository as never,
        {} as never,
      );

    const first = await run("corporate-messenger.send", { chat: "ops" });
    const second = await run("corporate-messenger.broadcast", { audience: "all" });

    expect(invoked).toEqual(["corporate-messenger.send", "corporate-messenger.broadcast"]);
    expect(first.outputPath).toBe("success");
    expect(second.outputPath).toBe("success");

    // Each node type is still checked by its own schema, not by the first one compiled: the config
    // that suits `send` is missing what `broadcast` requires, so it is refused before any call.
    const wrong = await run("corporate-messenger.broadcast", { chat: "ops" });
    expect(wrong.outputPath).toBe("error");
    expect(invoked).toHaveLength(2);
  });

  test("a granted alias with nothing saved is sent as null, not omitted", async () => {
    // "Not filled in" and "not permitted" must stay distinguishable on the handler's side: the
    // first is null here, the second is a named refusal raised by the runner.
    const handler = new ExtensionNodeHandler(registry, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    let seen: ExtensionInvocationRequest | undefined;

    await handler.execute(
      {
        type: "corporate-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-1",
        workflowId: "wf-1",
        userId: "user-1",
      } as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(seen!.secrets).toEqual({ "corporate-messenger.token": null });
  });

  test("a foreign alias that reached the grant list anyway is not read", async () => {
    // Registration refuses such a manifest, so this observes the second line of defence: the point
    // that actually reads a value and sends it out of the process. Required state: only the
    // extension's own settings leave. Plausible wrong state: the grant list is trusted as given, and
    // a value belonging to Moira or to another extension is handed over.
    const smuggling = new ExtensionRegistry();
    // A copy, so that reaching past registration below cannot leak into the shared manifest other
    // tests register.
    smuggling.register(JSON.parse(JSON.stringify(MANIFEST)) as ExtensionManifest);
    // Reach past registration the way a defect in it would: put the foreign alias into the
    // registered permissions directly.
    const registered = smuggling.get("corporate-messenger.send")!;
    (registered.permissions.secrets as string[]).push("telegram.bot_token");
    setActiveExtensionRegistry(smuggling);

    const handler = new ExtensionNodeHandler(smuggling, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    let seen: ExtensionInvocationRequest | undefined;

    await handler.execute(
      {
        type: "corporate-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-1",
        workflowId: "wf-1",
        userId: "user-1",
      } as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(Object.keys(seen!.secrets ?? {})).toEqual(["corporate-messenger.token"]);
    expect(seen!.secrets).not.toHaveProperty("telegram.bot_token");
  });

  test("an alias in the extension's own namespace that it never declared is not read", async () => {
    // The second half of the same door. A prefix test would pass this alias — it starts with the
    // extension name — while the value itself lives in Moira's ordinary settings, where the
    // repository decrypts it. Reading only declared settings is what separates "my setting" from
    // "any key that looks like mine".
    const smuggling = new ExtensionRegistry();
    smuggling.register(JSON.parse(JSON.stringify(MANIFEST)) as ExtensionManifest);
    const registered = smuggling.get("corporate-messenger.send")!;
    (registered.permissions.secrets as string[]).push("corporate-messenger.never-declared");
    setActiveExtensionRegistry(smuggling);

    const handler = new ExtensionNodeHandler(smuggling, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    let seen: ExtensionInvocationRequest | undefined;

    await handler.execute(
      {
        type: "corporate-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-1",
        workflowId: "wf-1",
        userId: "user-1",
      } as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(Object.keys(seen!.secrets ?? {})).toEqual(["corporate-messenger.token"]);
  });

  test("a structural value reaches the handler as its JSON, not as [object Object]", async () => {
    // Required state: a granted structural setting arrives usable. Plausible wrong state: the value
    // is stringified rather than serialised, so the handler receives `[object Object]` — a success
    // with a destroyed value, and nothing in the call says so.
    const granting = new ExtensionRegistry();
    granting.register({
      ...(JSON.parse(JSON.stringify(MANIFEST)) as ExtensionManifest),
      permissions: { secrets: ["corporate-messenger.routing"] },
    });
    setActiveExtensionRegistry(granting);
    await repository.setSetting("user-1", "corporate-messenger.routing", { default: "ops" });

    const handler = new ExtensionNodeHandler(granting, {
      async invoke(request) {
        seen = request;
        return { output: {} };
      },
    });
    let seen: ExtensionInvocationRequest | undefined;

    await handler.execute(
      {
        type: "corporate-messenger.send",
        id: "send",
        config: {},
        connections: { success: "end", error: "end" },
      } as never,
      {
        variables: {},
        nodeStates: {},
        executionId: "exec-1",
        workflowId: "wf-1",
        userId: "user-1",
      } as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(seen!.secrets!["corporate-messenger.routing"]).toBe('{"default":"ops"}');
  });

  test("a value refused by the declared schema is a named failure, not a silent no-op", async () => {
    await expect(
      repository.setSetting("user-1", "corporate-messenger.routing", { overrides: [] }),
    ).rejects.toThrow(/invalid value for corporate-messenger.routing/);

    expect(await repository.getSetting("user-1", "corporate-messenger.routing")).toBeNull();
  });
});
