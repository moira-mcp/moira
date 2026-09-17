/**
 * @jest-environment jsdom
 */

/**
 * A node's configuration read against the schema its type declares.
 *
 * The node level of the page's right panel (`NodePanel`) is the only place where a workflow author
 * sees what a catalog-drawn node is actually configured with, now that the flow page's node sidebar
 * is gone. Three states must stay apart on screen: a declared field that is set, a declared field
 * that is not, and a field the workflow sets that the type does not declare — the last is what a
 * stale workflow or a renamed field looks like, and it is invisible if the panel simply prints the
 * object. The panel must also name the extension the type came from, so the reader knows whose node
 * this is. `NodeDetailSheet`, the standalone sheet the graph still opens, reads the same way.
 */

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import type { Node } from "@xyflow/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import type { NodeTypeIndex } from "../../../packages/web-frontend/src/types/node-type-catalog";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types";

let NodePanel: typeof import("../../../packages/web-frontend/src/components/run/NodePanel").NodePanel;
let NodeDetailSheet: typeof import("../../../packages/web-frontend/src/components/workflow/NodeDetailSheet").NodeDetailSheet;

beforeAll(async () => {
  NodePanel = (await import("../../../packages/web-frontend/src/components/run/NodePanel"))
    .NodePanel;
  NodeDetailSheet = (
    await import("../../../packages/web-frontend/src/components/workflow/NodeDetailSheet")
  ).NodeDetailSheet;
});

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

const NODE_TYPE = "corporate-messenger.send";

const SCHEMA = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string", description: "Message body" },
    login: { type: "string" },
  },
};

/** The catalog as the server describes it: one type, contributed by an extension. */
const NODE_TYPES: NodeTypeIndex = {
  [NODE_TYPE]: {
    type: NODE_TYPE,
    title: "Send a message",
    description: "",
    schema: SCHEMA,
    schemaScope: "config",
    origin: "extension",
    extensionName: "corporate-messenger",
    extensionVersion: "2.1.0",
  },
};

/** A workflow whose only node is drawn from that catalog type, configured as given. */
function workflowWith(config: Record<string, unknown>): WorkflowGraph {
  return {
    id: "wf-1",
    metadata: { name: "Catalog", description: "", version: "1.0.0" },
    nodes: [
      {
        id: "sender",
        type: NODE_TYPE,
        progressActiveLabel: "Отправка сообщения",
        config,
      },
    ],
  } as unknown as WorkflowGraph;
}

function renderPanel(config: Record<string, unknown>): void {
  render(
    <I18nextProvider i18n={i18n}>
      <NodePanel
        workflow={workflowWith(config)}
        blocks={[]}
        nodeId="sender"
        nodeTypes={NODE_TYPES}
        onBack={() => {}}
      />
    </I18nextProvider>,
  );
}

/** The same node as the standalone sheet receives it, with the catalog data already folded in. */
function sheetNode(config: Record<string, unknown>): Node {
  return {
    id: "sender",
    type: "catalog",
    position: { x: 0, y: 0 },
    data: {
      nodeId: "sender",
      nodeType: "catalog",
      label: "Отправка сообщения",
      originalType: NODE_TYPE,
      origin: "extension",
      extensionName: "corporate-messenger",
      extensionVersion: "2.1.0",
      schemaScope: "config",
      schema: SCHEMA,
      config,
    },
  } as unknown as Node;
}

describe("the node panel of a node drawn from the catalog", () => {
  test("names the extension that contributed the type in the configuration section", () => {
    // Required state: the reader learns whose node this is. Plausible wrong state: the panel shows
    // only the configuration, so a field that behaves oddly names nobody to ask about it.
    renderPanel({ text: "hello" });

    expect(screen.getByTestId("node-panel-configuration")).toBeInTheDocument();
    expect(
      screen.getByText(/Provided by extension corporate-messenger 2\.1\.0/),
    ).toBeInTheDocument();
  });

  test("lists a declared field with its value and its description", () => {
    renderPanel({ text: "hello" });

    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("Message body")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("required")).toBeInTheDocument();
  });

  test("shows a declared field the workflow did not set as unset", () => {
    // Required state: the reader can see that `login` exists and is empty. Plausible wrong state:
    // the panel prints the configuration object, where an unset field is simply absent and
    // indistinguishable from a field the type does not have.
    renderPanel({ text: "hello" });

    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
  });

  test("keeps the schema visible when the authored configuration is empty", () => {
    // An empty object is still a real configuration. Hiding the section here would make every
    // required field disappear precisely when the author most needs the schema.
    renderPanel({});

    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getAllByText("not set")).toHaveLength(2);
  });

  test("marks a field the workflow sets that the type does not declare", () => {
    // This is what a renamed or removed configuration field looks like from the author's side.
    renderPanel({ text: "hello", chat: "0/0/e7" });

    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(screen.getByText("not declared by this node type")).toBeInTheDocument();
  });

  test("renders required, unset and undeclared states in Russian", async () => {
    await i18n.changeLanguage("ru");
    renderPanel({ chat: "0/0/e7" });

    expect(screen.getByText("обязательное поле")).toBeInTheDocument();
    expect(screen.getAllByText("не задано")).toHaveLength(2);
    expect(screen.getByText("не объявлено для этого типа узла")).toBeInTheDocument();
    expect(screen.queryByText("required")).not.toBeInTheDocument();
    expect(screen.queryByText("not set")).not.toBeInTheDocument();
  });

  test("uses the same schema readout in the standalone detail sheet, which names the type itself", () => {
    // The sheet is the surface where the namespaced type is printed verbatim: relaxing it the way
    // a built-in type is relaxed would turn an identifier the author matches against the workflow
    // into prose that names nothing.
    render(
      <I18nextProvider i18n={i18n}>
        <NodeDetailSheet
          open
          onOpenChange={() => {}}
          node={sheetNode({ text: "standalone" })}
          incomingNodes={[]}
          outgoingNodes={[]}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText(NODE_TYPE)).toBeInTheDocument();
    expect(screen.queryByText("corporate messenger.send")).not.toBeInTheDocument();
    expect(screen.getByText(/corporate-messenger 2\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText("standalone")).toBeInTheDocument();
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
  });
});
