/**
 * Unit tests for the extension registry — the source of truth about custom node types.
 *
 * The registry decides three things a workflow depends on: whether a manifest is acceptable at
 * all, which custom node types exist, and who owns each of them. A manifest is accepted whole or
 * rejected whole, so a partially valid manifest must contribute nothing.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  ExtensionRegistry,
  validateExtensionManifest,
  EXTENSION_API_VERSION,
  isExtensionNodeType,
  extensionNameOf,
  RESERVED_SETTING_NAMESPACES,
  settingNamespaceOf,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine";
import { initialDefinitions } from "../../../scripts/seed-settings-definitions.js";

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    apiVersion: EXTENSION_API_VERSION,
    name: "corporate-messenger",
    version: "1.0.0",
    entrypoint: "dist/index.js",
    nodes: [
      {
        type: "corporate-messenger.send",
        title: "Send message",
        configSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1 } },
        },
        outputSchema: {
          type: "object",
          required: ["messageId"],
          properties: { messageId: { type: "string" } },
        },
      },
    ],
    ...overrides,
  };
}

/**
 * Keys the installation seeds into the definitions table, taken from the seed script so the two
 * cannot drift apart silently.
 */
const SEEDED_BUILTIN_SETTING_KEYS = initialDefinitions.map((definition) => definition.key);

describe("Extension node type shape", () => {
  test.each([
    ["corporate-messenger.send", true],
    ["a1.b2", true],
    ["telegram-notification", false],
    ["start", false],
    ["Corporate.Send", false],
    ["corporate-messenger.", false],
    [".send", false],
  ])("isExtensionNodeType(%s) === %s", (type, expected) => {
    expect(isExtensionNodeType(type as string)).toBe(expected);
  });

  test("extension name is the segment before the dot, and null for built-in types", () => {
    expect(extensionNameOf("corporate-messenger.send")).toBe("corporate-messenger");
    expect(extensionNameOf("telegram-notification")).toBeNull();
  });
});

describe("Manifest validation", () => {
  test("a well-formed manifest is accepted", () => {
    expect(validateExtensionManifest(manifest())).toBeNull();
  });

  test("a manifest for another contract version is rejected with the version named", () => {
    const rejection = validateExtensionManifest(manifest({ apiVersion: "moira.extensions/v2" }));
    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain("moira.extensions/v2");
    expect(rejection!.reasons.join(" ")).toContain(EXTENSION_API_VERSION);
  });

  test("a node type outside the extension namespace is rejected", () => {
    const rejection = validateExtensionManifest(
      manifest({
        nodes: [
          {
            type: "other-extension.send",
            title: "Send",
            configSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(rejection!.reasons.join(" ")).toContain("must start with the extension name");
  });

  test("a setting key outside the extension namespace is rejected", () => {
    const rejection = validateExtensionManifest(
      manifest({
        settings: [{ key: "telegram.bot_token", type: "encrypted", label: "Token" }],
      }),
    );
    expect(rejection!.reasons.join(" ")).toContain("must live in the extension namespace");
  });

  test("an extension named after a built-in namespace cannot claim its settings", () => {
    // Required state: Moira's own setting namespaces stay Moira's. Plausible wrong state: only the
    // "key must start with the extension name" rule is checked, which an extension called
    // `telegram` satisfies while shadowing `telegram.bot_token` — and the database can no longer
    // refuse the duplicate, because a declared definition never reaches it.
    const rejection = validateExtensionManifest({
      apiVersion: EXTENSION_API_VERSION,
      name: "telegram",
      version: "1.0.0",
      entrypoint: "index.js",
      nodes: [
        {
          type: "telegram.send",
          title: "Send",
          configSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
      settings: [{ key: "telegram.bot_token", type: "encrypted", label: "Token" }],
    });

    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain("reserved namespace 'telegram'");
  });

  test("a secret alias outside the extension namespace is rejected", () => {
    // Required state: a grant can only ask for the extension's own settings. Plausible wrong state:
    // the namespace rule is applied to the declaration of a key and not to the request for its
    // value, and a manifest asking for `telegram.bot_token` is handed Moira's own secret — the exact
    // thing the permission model exists to prevent.
    const rejection = validateExtensionManifest(
      manifest({ permissions: { secrets: ["telegram.bot_token"] } }),
    );

    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain(
      "permissions.secrets entry 'telegram.bot_token' must live in the extension namespace",
    );
  });

  test("a secret alias belonging to another extension is rejected as well", () => {
    const rejection = validateExtensionManifest(
      manifest({ permissions: { secrets: ["other-extension.token"] } }),
    );

    expect(rejection!.reasons.join(" ")).toContain("must live in the extension namespace");
  });

  test("an extension named after a built-in namespace is refused even with no settings block", () => {
    // The case the settings-only check cannot see. The extension name *is* the namespace, so a
    // manifest that declares nothing and simply asks for `telegram.bot_token` used to pass every
    // check: the reserved-namespace rule lived inside the loop over `settings`, and the grant rule
    // only compared the alias with the extension's own name — which is `telegram`.
    const rejection = validateExtensionManifest({
      apiVersion: EXTENSION_API_VERSION,
      name: "telegram",
      version: "1.0.0",
      entrypoint: "index.js",
      nodes: [
        {
          type: "telegram.send",
          title: "Send",
          configSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
      permissions: { secrets: ["telegram.bot_token"] },
    });

    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain(
      "is a namespace Moira uses for its own settings",
    );
  });

  test("a grant naming a setting the manifest does not declare is refused at load", () => {
    // The documented promise: such a grant is refused when the bundle is loaded, not silently
    // turned into a `null` the handler cannot tell from an unfilled setting.
    const rejection = validateExtensionManifest(
      manifest({
        settings: [{ key: "corporate-messenger.token", type: "encrypted", label: "Token" }],
        permissions: { secrets: ["corporate-messenger.never-declared"] },
      }),
    );

    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain("is not declared in this manifest's settings");
  });

  test("permission fields with runtime-unsafe shapes are rejected at the manifest boundary", () => {
    const cases: Array<[unknown, string]> = [
      ["all" as never, "permissions' must be an object"],
      [{ network: "allowed.example" } as never, "permissions.network' must be an array"],
      [{ network: [42] } as never, "permissions.network entries must be non-empty strings"],
      [{ network: ["https://allowed.example/path"] }, "must be host names"],
      [{ artifacts: "yes" } as never, "permissions.artifacts' must be a boolean"],
    ];

    for (const [permissions, expected] of cases) {
      const rejection = validateExtensionManifest(manifest({ permissions }));
      expect(rejection).not.toBeNull();
      expect(rejection!.reasons.join(" ")).toContain(expected);
    }
  });

  test("duplicate settings and invalid optional setting fields are rejected", () => {
    const duplicate = validateExtensionManifest(
      manifest({
        settings: [
          { key: "corporate-messenger.token", type: "encrypted", label: "Token" },
          { key: "corporate-messenger.token", type: "encrypted", label: "Token again" },
        ],
      }),
    );
    expect(duplicate!.reasons.join(" ")).toContain("declared twice");

    const invalidOptionals = validateExtensionManifest(
      manifest({
        settings: [
          {
            key: "corporate-messenger.token",
            type: "encrypted",
            label: "Token",
            description: 42 as never,
            defaultValue: false as never,
            required: "yes" as never,
            adminOnly: "no" as never,
          },
        ],
      }),
    );
    const reasons = invalidOptionals!.reasons.join(" ");
    expect(reasons).toContain("description must be a string");
    expect(reasons).toContain("defaultValue must be a string");
    expect(reasons).toContain("required must be a boolean");
    expect(reasons).toContain("adminOnly must be a boolean");
  });

  test("every namespace the installation seeds is reserved", () => {
    // The list of reserved namespaces is written by hand, so it can fall behind a newly seeded
    // built-in setting. Comparing it against the definitions the installation actually seeds makes
    // that omission fail here rather than as an extension shadowing a built-in setting later.
    for (const key of SEEDED_BUILTIN_SETTING_KEYS) {
      expect(RESERVED_SETTING_NAMESPACES as readonly string[]).toContain(settingNamespaceOf(key));
    }
  });

  test("the same node type declared twice in one manifest is rejected", () => {
    // Without this check the second declaration would quietly overwrite the first in the type map,
    // so which declaration wins would depend on the order of entries in the manifest file. The
    // cross-extension conflict test does not cover it: that is a different branch with two names.
    const rejection = validateExtensionManifest(
      manifest({
        nodes: [
          {
            type: "corporate-messenger.send",
            title: "Send",
            configSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          {
            type: "corporate-messenger.send",
            title: "Send again",
            configSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(rejection).not.toBeNull();
    expect(rejection!.reasons.join(" ")).toContain("declared twice");
  });

  test("a schema that is an object but not a compilable schema is rejected by name", () => {
    // Required state: an unusable schema is a defect of the bundle, named here, where the manifest
    // is judged. Plausible wrong state: the shape check ("is an object") passes it, and the defect
    // surfaces later as an exception thrown inside whichever consumer compiled it first — which
    // from outside looks like Moira breaking rather than the bundle being wrong. Every schema a
    // manifest declares is checked, because the consumer differs for each of them.
    const cases: Array<[string, ExtensionManifest]> = [
      [
        "nodes[0].configSchema",
        manifest({
          nodes: [
            {
              type: "corporate-messenger.send",
              title: "Send",
              configSchema: { type: "banana" },
              outputSchema: { type: "object" },
            },
          ],
        }),
      ],
      [
        "nodes[0].outputSchema",
        manifest({
          nodes: [
            {
              type: "corporate-messenger.send",
              title: "Send",
              configSchema: { type: "object" },
              outputSchema: { required: "messageId" },
            },
          ],
        }),
      ],
      [
        "nodes[0].inputSchema",
        manifest({
          nodes: [
            {
              type: "corporate-messenger.send",
              title: "Send",
              configSchema: { type: "object" },
              inputSchema: { properties: [] },
              outputSchema: { type: "object" },
            },
          ],
        }),
      ],
      [
        "settings[0].validation",
        manifest({
          settings: [
            {
              key: "corporate-messenger.routing",
              type: "json",
              label: "Routing table",
              validation: { type: "banana" },
            },
          ],
          permissions: { secrets: ["corporate-messenger.routing"] },
        }),
      ],
    ];

    for (const [where, candidate] of cases) {
      const rejection = validateExtensionManifest(candidate);
      expect(rejection).not.toBeNull();
      expect(rejection!.reasons.join(" ")).toContain(`${where} is not a usable JSON Schema`);
    }
  });

  test("a declared validation schema that is not an object at all is rejected", () => {
    const rejection = validateExtensionManifest(
      manifest({
        settings: [
          {
            key: "corporate-messenger.routing",
            type: "json",
            label: "Routing table",
            validation: "type: object" as never,
          },
        ],
        permissions: { secrets: ["corporate-messenger.routing"] },
      }),
    );

    expect(rejection!.reasons.join(" ")).toContain("settings[0].validation must be a JSON Schema");
  });

  test("a compilable schema with main-process executable-cost keywords is rejected", () => {
    const rejection = validateExtensionManifest(
      manifest({
        nodes: [
          {
            type: "corporate-messenger.send",
            title: "Send",
            configSchema: { type: "object", properties: { text: { pattern: "(a+)+$" } } },
            outputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(rejection!.reasons.join(" ")).toContain("keyword 'pattern' is not allowed");
  });

  test("ordinary property names are not mistaken for schema keywords", () => {
    const rejection = validateExtensionManifest(
      manifest({
        nodes: [
          {
            type: "corporate-messenger.send",
            title: "Send",
            configSchema: {
              type: "object",
              properties: {
                pattern: { type: "string" },
                $ref: { type: "string" },
                patternProperties: { type: "boolean" },
              },
            },
            outputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(rejection).toBeNull();
  });

  test("every manifest this repository ships is still accepted", () => {
    // The check above only earns its place if it refuses unusable schemas and nothing else: a
    // stricter compiler setting that also refused ordinary schemas would keep that test green while
    // making every real bundle uninstallable. The manifests the repository actually ships — the
    // fixtures the runner is exercised on are what currently distinguishes those two states, so
    // they are read from disk rather than restated here. The reference-example unit extends this
    // set when it adds the user-facing bundles.
    const roots = ["tests/fixtures/extension-bundles"];
    const manifests: Array<{ where: string; content: unknown }> = [];
    for (const root of roots) {
      const dir = path.resolve(process.cwd(), root);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, "moira-extension.json");
        if (!fs.existsSync(file)) continue;
        manifests.push({
          where: `${root}/${entry.name}`,
          content: JSON.parse(fs.readFileSync(file, "utf8")),
        });
      }
    }

    // An empty list would make the assertion below vacuous, which is the way this observation
    // could quietly stop observing anything.
    expect(manifests.length).toBeGreaterThanOrEqual(2);
    for (const shipped of manifests) {
      expect({
        where: shipped.where,
        rejection: validateExtensionManifest(shipped.content),
      }).toEqual({ where: shipped.where, rejection: null });
    }
  });

  test("all reasons are reported together rather than the first one", () => {
    const rejection = validateExtensionManifest({
      apiVersion: "wrong",
      name: "Bad Name",
      version: "not-semver",
      entrypoint: "",
      nodes: [],
    });
    expect(rejection!.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("ExtensionRegistry", () => {
  let registry: ExtensionRegistry;

  beforeEach(() => {
    registry = new ExtensionRegistry();
  });

  test("registering a manifest makes its node types known", () => {
    expect(registry.register(manifest()).registered).toBe(true);
    expect(registry.has("corporate-messenger.send")).toBe(true);
    expect(registry.nodeTypes()).toEqual(["corporate-messenger.send"]);
    expect(registry.get("corporate-messenger.send")!.extensionName).toBe("corporate-messenger");
  });

  test("an invalid manifest contributes nothing at all", () => {
    const invalid = manifest({
      nodes: [
        {
          type: "corporate-messenger.send",
          title: "Send",
          configSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
        // Second node is invalid: the whole manifest must be refused, not just this entry.
        {
          type: "not-namespaced",
          title: "Broken",
          configSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    });

    expect(registry.register(invalid).registered).toBe(false);
    expect(registry.has("corporate-messenger.send")).toBe(false);
    expect(registry.nodeTypes()).toEqual([]);
  });

  test("two extensions claiming the same node type are both named in the refusal", () => {
    registry.register(manifest());
    const result = registry.register(
      manifest({
        name: "rival",
        nodes: [
          {
            type: "corporate-messenger.send",
            title: "Send",
            configSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(result.registered).toBe(false);
    const reasons = result.rejection!.reasons.join(" ");
    // The type belongs to someone: the message must name the current owner, and the rejection
    // must carry the newcomer, otherwise an operator cannot tell which bundle to remove.
    expect(reasons).toContain("corporate-messenger");
    expect(result.rejection!.manifestName).toBe("rival");
  });

  test("unregistering removes the extension and every type it owned", () => {
    registry.register(manifest());
    expect(registry.unregister("corporate-messenger")).toBe(true);
    expect(registry.has("corporate-messenger.send")).toBe(false);
    expect(registry.manifests()).toEqual([]);
    expect(registry.unregister("corporate-messenger")).toBe(false);
  });

  test("declared settings are exposed with their owning extension", () => {
    registry.register(
      manifest({
        settings: [
          { key: "corporate-messenger.token", type: "encrypted", label: "API token" },
          { key: "corporate-messenger.base_url", type: "string", label: "Base URL" },
        ],
      }),
    );

    expect(registry.settingDeclarations().map((entry) => entry.declaration.key)).toEqual([
      "corporate-messenger.token",
      "corporate-messenger.base_url",
    ]);
    expect(registry.settingDeclarations()[0].extensionName).toBe("corporate-messenger");
  });

  test("the snapshot carries contract version and data-only node declarations", () => {
    registry.register(manifest());
    const snapshot = registry.snapshot(new Date("2026-09-02T00:00:00.000Z"));

    expect(snapshot).toEqual({
      apiVersion: EXTENSION_API_VERSION,
      generatedAt: "2026-09-02T00:00:00.000Z",
      extensions: [
        {
          name: "corporate-messenger",
          version: "1.0.0",
          nodes: manifest().nodes,
        },
      ],
    });
  });
});
