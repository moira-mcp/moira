/**
 * How a node whose type this bundle has no branch for is drawn.
 *
 * The two states that must stay distinguishable: the view takes what it shows from the catalog
 * Moira serves, or it takes it from the type string and a table compiled into the bundle. Both look
 * right for a type whose title happens to equal its name, so the observations here use titles that
 * cannot be derived from the type, and check what happens when the catalog is absent.
 */

import { describe, expect, test } from "@jest/globals";
import { WorkflowTransformer } from "../../../packages/web-frontend/src/utils/workflow-transformer";
import type { NodeTypeIndex } from "../../../packages/web-frontend/src/types/node-type-catalog";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types";

const CATALOG: NodeTypeIndex = {
  "corporate-messenger.send": {
    type: "corporate-messenger.send",
    title: "Отправка сообщения",
    description: "Sends a message to the configured recipient.",
    origin: "extension",
    extensionName: "corporate-messenger",
    extensionVersion: "2.1.0",
    schema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" }, login: { type: "string" } },
    },
    schemaScope: "config",
  },
  "audit-log.append": {
    type: "audit-log.append",
    title: "Запись в журнал",
    description: "Appends a line to the audit journal.",
    origin: "extension",
    extensionName: "audit-log",
    extensionVersion: "0.9.0",
    schema: {
      type: "object",
      required: ["line", "level"],
      properties: { line: { type: "string" }, level: { type: "string", enum: ["info", "warn"] } },
    },
    schemaScope: "config",
  },
  lock: {
    type: "lock",
    title: "Lock",
    description: "Acquires or releases a named lock so that executions do not collide.",
    origin: "builtin",
    schema: { type: "object" },
    schemaScope: "node",
  },
};

function workflowWith(node: Record<string, unknown>): WorkflowGraph {
  return {
    id: "wf-1",
    metadata: { name: "Catalog", description: "", version: "1.0.0" },
    nodes: [
      {
        id: "start",
        type: "start",
        connections: { default: "subject" },
      },
      node,
      { id: "done", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

const EXTENSION_NODE = {
  id: "subject",
  type: "corporate-messenger.send",
  config: { text: "hello", chat: "0/0/e7" },
  connections: { success: "done" },
};

function subjectData(catalog: NodeTypeIndex) {
  const result = WorkflowTransformer.transformWorkflow(
    workflowWith(EXTENSION_NODE),
    undefined,
    undefined,
    catalog,
  );
  const node = result.nodes.find((item) => item.id === "subject");
  expect(node).toBeDefined();
  return node!;
}

describe("A node type the bundle has no branch for", () => {
  test("is drawn from the catalog: title, description and owner come from the server", () => {
    // Required state: the card shows what the extension declared. Plausible wrong state: the view
    // derives a label from the type string, which for this extension would read "SEND" or
    // "corporate-messenger.send" — indistinguishable from correct if the title equalled the name,
    // which is why the title here is not derivable from it.
    const node = subjectData(CATALOG);
    const data = node.data as Record<string, unknown>;

    expect(node.type).toBe("catalog");
    expect(data.label).toBe("Отправка сообщения");
    expect(data.description).toBe("Sends a message to the configured recipient.");
    expect(data.extensionName).toBe("corporate-messenger");
    expect(data.extensionVersion).toBe("2.1.0");
    expect(data.originalType).toBe("corporate-messenger.send");
  });

  test("carries the declared schema and the authored configuration for the panel", () => {
    const data = subjectData(CATALOG).data as Record<string, unknown>;

    expect(data.schemaScope).toBe("config");
    expect((data.schema as Record<string, unknown>).required).toEqual(["text"]);
    expect(data.config).toEqual({ text: "hello", chat: "0/0/e7" });
  });

  test("without the catalog the same node is unknown, and the extension is named", () => {
    // The distinguishing half of the first observation: remove the server's answer and the card
    // must lose the extension's title. It must not lose the reason — a namespaced type that the
    // installation does not know belongs to an extension that is not connected here.
    const node = subjectData({});
    const data = node.data as Record<string, unknown>;

    expect(node.type).toBe("fallback");
    expect(data.label).toBe("CORPORATE-MESSENGER.SEND");
    expect(data.fallbackReason).toBe("extension-unavailable");
    expect(data.extensionName).toBe("corporate-messenger");
    expect(data.description).toBeUndefined();
  });

  test("a live catalog distinguishes a missing extension from an unavailable registry", () => {
    const result = WorkflowTransformer.transformWorkflow(
      workflowWith(EXTENSION_NODE),
      undefined,
      undefined,
      {},
      true,
    );
    const node = result.nodes.find((item) => item.id === "subject")!;

    expect((node.data as Record<string, unknown>).fallbackReason).toBe("extension-missing");
    expect((node.data as Record<string, unknown>).extensionName).toBe("corporate-messenger");
  });

  test("a built-in type the bundle never knew is drawn as a built-in type, not as unknown", () => {
    // `lock` and `teleport` are built into the engine and were absent from the browser's own list.
    const result = WorkflowTransformer.transformWorkflow(
      workflowWith({ id: "subject", type: "lock", connections: { success: "done" } }),
      undefined,
      undefined,
      CATALOG,
    );
    const node = result.nodes.find((item) => item.id === "subject")!;
    const data = node.data as Record<string, unknown>;

    expect(node.type).toBe("catalog");
    expect(data.origin).toBe("builtin");
    expect(data.label).toBe("Lock");
    expect(data.extensionName).toBeUndefined();
    // A built-in catalog schema describes the whole node, unlike an extension schema which
    // describes only `config`; the panel must receive the matching value shape.
    expect(data.schemaScope).toBe("node");
    expect(data.config).toMatchObject({
      id: "subject",
      type: "lock",
      connections: { success: "done" },
    });
  });

  test("a truly unknown type stays unknown even with a catalog", () => {
    const result = WorkflowTransformer.transformWorkflow(
      workflowWith({ id: "subject", type: "not-a-type", connections: { success: "done" } }),
      undefined,
      undefined,
      CATALOG,
    );
    const node = result.nodes.find((item) => item.id === "subject")!;

    expect(node.type).toBe("fallback");
    expect((node.data as Record<string, unknown>).fallbackReason).toBe("unknown");
    expect((node.data as Record<string, unknown>).extensionName).toBeUndefined();
  });
});

describe("Two different declarations", () => {
  test("give two different cards in the same code", () => {
    // The planned distinguishing observation: a card written for one extension looks correct for
    // that extension. Required state: what differs between two declarations — title, description,
    // owner, version and the declared schema — differs on the cards. Plausible wrong state: the
    // renderer carries one extension's shape and fills the rest from the type string, which one
    // declaration alone cannot tell apart.
    const messenger = subjectData(CATALOG).data as Record<string, unknown>;
    const auditResult = WorkflowTransformer.transformWorkflow(
      workflowWith({
        id: "subject",
        type: "audit-log.append",
        config: { line: "started", level: "info" },
        connections: { success: "done" },
      }),
      undefined,
      undefined,
      CATALOG,
    );
    const audit = auditResult.nodes.find((item) => item.id === "subject")!.data as Record<
      string,
      unknown
    >;

    expect([messenger.label, audit.label]).toEqual(["Отправка сообщения", "Запись в журнал"]);
    expect([messenger.description, audit.description]).toEqual([
      "Sends a message to the configured recipient.",
      "Appends a line to the audit journal.",
    ]);
    expect([messenger.extensionName, audit.extensionName]).toEqual([
      "corporate-messenger",
      "audit-log",
    ]);
    expect([messenger.extensionVersion, audit.extensionVersion]).toEqual(["2.1.0", "0.9.0"]);
    // The schemas the panel reads differ too: different required fields, different properties.
    expect((messenger.schema as Record<string, unknown>).required).toEqual(["text"]);
    expect((audit.schema as Record<string, unknown>).required).toEqual(["line", "level"]);
    expect(messenger.config).toEqual({ text: "hello", chat: "0/0/e7" });
    expect(audit.config).toEqual({ line: "started", level: "info" });
  });
});

describe("Built-in types with their own rendering", () => {
  test("keep their type, label and colour when a catalog is present", () => {
    // The catalog must not swallow the types this bundle draws itself: the start node has its own
    // branch, and a change that routed everything through the catalog would show it as a generic
    // card while every observation about the extension node stayed green.
    const result = WorkflowTransformer.transformWorkflow(
      workflowWith(EXTENSION_NODE),
      undefined,
      undefined,
      CATALOG,
    );
    const start = result.nodes.find((item) => item.id === "start")!;
    const data = start.data as Record<string, unknown>;

    expect(start.type).toBe("start");
    expect(data.label).toBe("Start");
    expect(data.icon).toBe("play");
  });
});
