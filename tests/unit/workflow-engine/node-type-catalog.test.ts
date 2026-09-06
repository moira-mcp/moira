/**
 * What Moira says exists, for a client that cannot know.
 *
 * The catalog is the answer to "which node types are there" computed where the truth lives. The two
 * states it must distinguish are "the client is told what this installation actually has" and "the
 * client is told what somebody wrote down once": a list that omits a built-in type, or omits the
 * types of an installed extension, looks exactly like a working catalog until the workflow using
 * that type is opened.
 */

import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildNodeTypeCatalog,
  builtinNodeTypeDescriptors,
  classifyNodeType,
  ExtensionRegistry,
  getActiveExtensionRegistry,
  initializeExtensionsForProcess,
  setActiveExtensionRegistry,
  BUILTIN_NODE_TYPES,
  EXTENSION_API_VERSION,
  type ExtensionManifest,
} from "../../../packages/workflow-engine/src/index.js";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "2.1.0",
  entrypoint: "./index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send corporate message",
      description: "Sends a message to the configured recipient.",
      configSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Message body" },
          login: { type: "string" },
        },
      },
      outputSchema: { type: "object", properties: { messageId: { type: "string" } } },
    },
  ],
};

function registryWith(manifest: ExtensionManifest, origin: "live" | "snapshot" = "live") {
  const registry = new ExtensionRegistry(origin);
  const result = registry.register(manifest);
  expect(result.rejection).toBeUndefined();
  expect(result.registered).toBe(true);
  return registry;
}

describe("Built-in types in the catalog", () => {
  test("every built-in type of the engine is described", () => {
    // Required state: the catalog covers the engine's own list, so a type that ships is drawable.
    // Plausible wrong state: the catalog carries its own list of "the usual" types, and a type like
    // `materialize` — or `lock` and `teleport`, which the browser never knew — is simply absent, so
    // a valid workflow shows unknown nodes.
    const described = builtinNodeTypeDescriptors().map((descriptor) => descriptor.type);

    expect([...described].sort()).toEqual([...BUILTIN_NODE_TYPES].sort());
  });

  test("a built-in entry carries a title and the schema branch of that type", () => {
    const entry = builtinNodeTypeDescriptors().find((item) => item.type === "agent-directive");

    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Agent Task");
    expect(entry!.origin).toBe("builtin");
    expect(entry!.schemaScope).toBe("node");
    // The schema is the engine's own branch for the type, not a hand-written copy: its `type`
    // property is pinned to the very type it describes.
    const properties = entry!.schema?.properties as Record<string, { const?: string }> | undefined;
    expect(properties?.type?.const).toBe("agent-directive");
  });

  test("lock and teleport are described like any other built-in type", () => {
    // These two exist in the engine and were missing from the browser's own list, which is how they
    // came to be drawn as unknown nodes.
    const byType = new Map(builtinNodeTypeDescriptors().map((item) => [item.type, item]));

    expect(byType.get("lock")?.title).toBe("Lock");
    expect(byType.get("teleport")?.title).toBe("Teleport");
  });

  test("materialize describes its bounded reusable node-bound download contract", () => {
    const materialize = builtinNodeTypeDescriptors().find((item) => item.type === "materialize");

    expect(materialize?.description).toContain("reusable five-minute download");
    expect(materialize?.description).toContain("waiting node");
    expect(materialize?.description).not.toContain("one-use");
  });
});

describe("An installation with no extension service", () => {
  test("says it cannot conclude absence, and names no extension as missing", async () => {
    // The state every ordinary installation is in, reached the way the product reaches it rather
    // than by constructing a registry by hand. Required state: the catalog reports that absence
    // cannot be concluded, and a namespaced type is classified as unresolvable. Plausible wrong
    // state: start-up installs an empty registry that calls itself live, so the installation
    // announces "this extension is not installed" about extensions it was never able to look for —
    // and every hand-built registry in the other observations stays green.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-catalog-"));
    try {
      await initializeExtensionsForProcess({
        runnerUrl: null,
        createClient: () => {
          throw new Error("no client may be built when no runner is configured");
        },
        publishSnapshot: false,
        stateDir,
      });

      const registry = getActiveExtensionRegistry();
      const catalog = buildNodeTypeCatalog(registry);

      expect(catalog.extensionsAvailable).toBe(false);
      expect(catalog.nodeTypes.every((entry) => entry.origin === "builtin")).toBe(true);

      const classification = classifyNodeType("corporate-messenger.send", registry);
      expect(classification.kind).toBe("extension-unresolvable");
    } finally {
      setActiveExtensionRegistry(null);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("An installation whose extension service has not answered", () => {
  test("says it cannot conclude absence, exactly as when no service is configured", async () => {
    // The state of an installation whose extension service starts a moment later, or is down: the
    // address is configured, the first call fails, and the registry stays empty. Required state:
    // the catalog reports that absence cannot be concluded and the type is unresolvable. Plausible
    // wrong state: the registry calls itself live because an address was configured, so every
    // workflow using that extension is declared broken with the reason "extension not installed".
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-catalog-"));
    try {
      const result = await initializeExtensionsForProcess({
        runnerUrl: "http://127.0.0.1:9/unreachable",
        createClient: () => ({
          listExtensions: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        }),
        publishSnapshot: false,
        stateDir,
      } as unknown as Parameters<typeof initializeExtensionsForProcess>[0]);

      expect(result.synced).toBe(false);

      const registry = getActiveExtensionRegistry();
      expect(buildNodeTypeCatalog(registry).extensionsAvailable).toBe(false);

      const classification = classifyNodeType("corporate-messenger.send", registry);
      expect(classification.kind).toBe("extension-unresolvable");
    } finally {
      setActiveExtensionRegistry(null);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a service that answers restores the state in which absence may be concluded", async () => {
    // The other half: when the service does answer, an unknown namespaced type is genuinely absent,
    // and a repair that made every installation "cannot tell" would lose that.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-catalog-"));
    try {
      const result = await initializeExtensionsForProcess({
        runnerUrl: "http://127.0.0.1:9/answers",
        createClient: () => ({ listExtensions: async () => [MANIFEST] }),
        publishSnapshot: false,
        stateDir,
      } as unknown as Parameters<typeof initializeExtensionsForProcess>[0]);

      expect(result.synced).toBe(true);

      const registry = getActiveExtensionRegistry();
      const catalog = buildNodeTypeCatalog(registry);

      expect(catalog.extensionsAvailable).toBe(true);
      expect(catalog.nodeTypes.some((entry) => entry.type === "corporate-messenger.send")).toBe(
        true,
      );
      expect(classifyNodeType("absent-extension.node", registry).kind).toBe("extension-missing");
    } finally {
      setActiveExtensionRegistry(null);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Origin and owner are one decision", () => {
  test("a built-in entry carries no owner and an extension entry always does", () => {
    // Required state: the two fields cannot disagree. Plausible wrong state: they are independent,
    // and a built-in type with an extension name is shown as contributed by an extension that never
    // declared it — a state the type used to allow and no consumer could detect.
    const catalog = buildNodeTypeCatalog(registryWith(MANIFEST));

    for (const entry of catalog.nodeTypes) {
      if (entry.origin === "builtin") {
        expect(entry.extensionName).toBeUndefined();
        expect(entry.extensionVersion).toBeUndefined();
      } else {
        expect(typeof entry.extensionName).toBe("string");
        expect(typeof entry.extensionVersion).toBe("string");
      }
    }
  });
});

describe("Extension types in the catalog", () => {
  test("a registered extension contributes its declaration, owner and config schema", () => {
    // Required state: the client receives what the extension declared. Plausible wrong state: only
    // the type string travels, and the client invents a title from it — which looks right for
    // `corporate-messenger.send` and wrong for every extension whose title is not its type.
    const catalog = buildNodeTypeCatalog(registryWith(MANIFEST));
    const entry = catalog.nodeTypes.find((item) => item.type === "corporate-messenger.send");

    expect(entry).toEqual({
      type: "corporate-messenger.send",
      title: "Send corporate message",
      description: "Sends a message to the configured recipient.",
      origin: "extension",
      extensionName: "corporate-messenger",
      extensionVersion: "2.1.0",
      schema: MANIFEST.nodes[0]!.configSchema,
      schemaScope: "config",
    });
  });

  test("the catalog carries built-in and extension types together, sorted by type", () => {
    const catalog = buildNodeTypeCatalog(registryWith(MANIFEST));
    const types = catalog.nodeTypes.map((item) => item.type);

    expect(types).toContain("corporate-messenger.send");
    expect(types).toContain("materialize");
    expect(types).toEqual([...types].sort());
  });

  test("no registry means built-in types only, and the client is told it cannot conclude absence", () => {
    // Required state: without an extension service the catalog still works and says so. Plausible
    // wrong state: `extensionsAvailable` is derived from "did we return any extension types", which
    // is true-looking on an installation whose extensions are simply not installed yet, and the
    // client then reports a namespaced type as unknown instead of not connected.
    const catalog = buildNodeTypeCatalog(null);

    expect(catalog.extensionsAvailable).toBe(false);
    expect(catalog.nodeTypes.every((item) => item.origin === "builtin")).toBe(true);
  });

  test("a snapshot-backed registry lists its types but is not treated as a live source", () => {
    // A snapshot cannot say that an extension is absent, so the client must not conclude it either.
    const catalog = buildNodeTypeCatalog(registryWith(MANIFEST, "snapshot"));

    expect(catalog.nodeTypes.some((item) => item.type === "corporate-messenger.send")).toBe(true);
    expect(catalog.extensionsAvailable).toBe(false);
  });

  test("a live registry with an extension reports that absence can be concluded", () => {
    expect(buildNodeTypeCatalog(registryWith(MANIFEST)).extensionsAvailable).toBe(true);
  });

  test("the catalog carries no setting declarations of the extension", () => {
    // The response is read by any authenticated user; settings and their values belong to the
    // settings API, which masks secrets. Nothing here may carry them.
    const withSettings: ExtensionManifest = {
      ...MANIFEST,
      settings: [
        {
          key: "corporate-messenger.token",
          type: "encrypted",
          label: "Token",
        },
      ],
    };
    const catalog = buildNodeTypeCatalog(registryWith(withSettings));

    expect(JSON.stringify(catalog)).not.toContain("corporate-messenger.token");
  });
});
