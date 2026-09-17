/**
 * @jest-environment jsdom
 */

/**
 * Which output of a node leads where.
 *
 * A routing node has one output per case, and several of them usually lead to the same block. The
 * required state is that each outgoing chip names its output; the plausible wrong state — the one
 * this test exists to catch — is a list of target names, which for a four-way condition prints the
 * same name three times and tells the reader nothing about the routing.
 *
 * The chips are read through `NodeDetailSheet`, the panel that still renders them after the flow
 * page's node sidebar was retired; the sheet is the only surface a reader reaches them from.
 */

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import type { Node } from "@xyflow/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";

let NodeDetailSheet: typeof import("../../../packages/web-frontend/src/components/workflow/NodeDetailSheet").NodeDetailSheet;

beforeAll(async () => {
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

/** A four-way review gate: three verdicts go back to the same block, one goes forward. */
const OUTGOING = [
  { id: "fix", label: "Fix the work", connectionType: "blocker" },
  { id: "fix", label: "Fix the work", connectionType: "major" },
  { id: "fix", label: "Fix the work", connectionType: "minor" },
  { id: "ship", label: "Ship it", connectionType: "default" },
];

function conditionNode(cases?: Array<{ summary?: string; output: string }>): Node {
  return {
    id: "verdict",
    type: "condition",
    position: { x: 0, y: 0 },
    data: { nodeId: "verdict", nodeType: "condition", label: "Verdict", cases },
  } as unknown as Node;
}

function renderPanel(cases?: Array<{ summary?: string; output: string }>): void {
  render(
    <I18nextProvider i18n={i18n}>
      <NodeDetailSheet
        open
        onOpenChange={() => {}}
        node={conditionNode(cases)}
        incomingNodes={[]}
        outgoingNodes={OUTGOING}
      />
    </I18nextProvider>,
  );
}

describe("the outgoing connections of a routing node", () => {
  test("names every output, so four edges into two targets stay apart", () => {
    renderPanel();
    const chips = screen.getAllByTestId("outgoing-connection");
    expect(chips.map((chip) => chip.getAttribute("data-output"))).toEqual([
      "blocker",
      "major",
      "minor",
      "default",
    ]);
    for (const chip of chips) {
      expect(chip.textContent).toContain(chip.getAttribute("data-output"));
    }
    expect(chips[0].textContent).toContain("Fix the work");
    expect(chips[3].textContent).toContain("Ship it");
  });

  test("a chip carries the case that selects its output, and none for an output without one", () => {
    renderPanel([
      { output: "blocker", summary: "a blocking defect was found" },
      { output: "minor", summary: "only nits were found" },
    ]);
    const chips = screen.getAllByTestId("outgoing-connection");
    expect(chips[0].textContent).toContain("a blocking defect was found");
    expect(chips[2].textContent).toContain("only nits were found");
    expect(chips[1].textContent).not.toContain("when");
    expect(chips[3].textContent).not.toContain("when");
  });

  test("each chip's tooltip reads output → target so it survives truncation", () => {
    renderPanel([{ output: "blocker", summary: "a blocking defect was found" }]);
    const chips = screen.getAllByTestId("outgoing-connection");
    expect(chips[0].getAttribute("title")).toBe(
      "blocker → Fix the work · a blocking defect was found",
    );
    expect(chips[3].getAttribute("title")).toBe("default → Ship it");
  });
});
