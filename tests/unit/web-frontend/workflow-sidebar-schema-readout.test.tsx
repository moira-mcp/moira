/**
 * @jest-environment jsdom
 */

/**
 * A node's configuration read against the schema its type declares.
 *
 * The panel is the only place where a workflow author sees what a custom node is actually
 * configured with. Three states must stay apart on screen: a declared field that is set, a declared
 * field that is not, and a field the workflow sets that the type does not declare — the last is what
 * a stale workflow or a renamed field looks like, and it is invisible if the panel simply prints the
 * object.
 */

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Node } from "@xyflow/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";

let WorkflowSidebar: typeof import("../../../packages/web-frontend/src/components/workflow/WorkflowSidebar").WorkflowSidebar;
let NodeDetailSheet: typeof import("../../../packages/web-frontend/src/components/workflow/NodeDetailSheet").NodeDetailSheet;

beforeAll(async () => {
  WorkflowSidebar = (
    await import("../../../packages/web-frontend/src/components/workflow/WorkflowSidebar")
  ).WorkflowSidebar;
  NodeDetailSheet = (
    await import("../../../packages/web-frontend/src/components/workflow/NodeDetailSheet")
  ).NodeDetailSheet;
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

const WORKFLOW = {
  id: "wf-1",
  metadata: { name: "Catalog", description: "", version: "1.0.0" },
  nodes: [],
} as unknown as Parameters<typeof WorkflowSidebar>[0]["workflow"];

function nodeWith(config: Record<string, unknown>): Node {
  return {
    id: "sender",
    type: "catalog",
    position: { x: 0, y: 0 },
    data: {
      nodeId: "sender",
      nodeType: "catalog",
      label: "Отправка сообщения",
      originalType: "corporate-messenger.send",
      origin: "extension",
      extensionName: "corporate-messenger",
      extensionVersion: "2.1.0",
      schemaScope: "config",
      schema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Message body" },
          login: { type: "string" },
        },
      },
      config,
    },
  } as unknown as Node;
}

function renderPanel(config: Record<string, unknown>) {
  render(
    <I18nextProvider i18n={i18n}>
      <WorkflowSidebar
        workflow={WORKFLOW}
        selectedNode={nodeWith(config)}
        incomingNodes={[]}
        outgoingNodes={[]}
      />
    </I18nextProvider>,
  );
}

describe("The panel of a node drawn from the catalog", () => {
  test("names the extension that contributed the type, and the type itself", () => {
    // Required state: the reader learns whose node this is. Plausible wrong state: the panel shows
    // how the node is drawn — `catalog` — which is an internal word and names nobody.
    renderPanel({ text: "hello" });

    expect(screen.getByText("corporate-messenger.send")).toBeInTheDocument();
    expect(screen.getByText(/corporate-messenger 2\.1\.0/)).toBeInTheDocument();
  });

  test("prints a built-in type in its readable form and a namespaced one verbatim", () => {
    // One rule, two cases: `agent-directive` reads better relaxed, while `corporate-messenger.send`
    // is an identifier the author matches against the workflow — relaxing it names nothing.
    renderPanel({ text: "hello" });
    expect(screen.getByText("corporate-messenger.send")).toBeInTheDocument();
    expect(screen.queryByText("corporate messenger.send")).not.toBeInTheDocument();
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

  test("uses the same schema readout in the standalone detail sheet", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <NodeDetailSheet
          open
          onOpenChange={() => {}}
          node={nodeWith({ text: "standalone" })}
          incomingNodes={[]}
          outgoingNodes={[]}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("corporate-messenger.send")).toBeInTheDocument();
    expect(screen.getByText("standalone")).toBeInTheDocument();
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
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
});
