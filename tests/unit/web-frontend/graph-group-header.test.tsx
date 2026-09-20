/** @jest-environment jsdom */
import React from "react";
import { describe, expect, test } from "@jest/globals";
import { render } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { GRAPH_FLOW_ENTRY_STRIP } from "../../../packages/web-frontend/src/components/workflow/graphLayout";
import {
  BlockGroupView,
  type BlockGroupNode,
} from "../../../packages/web-frontend/src/components/workflow/graphNodes";

function groupProps(reserveFlowEntryStrip: boolean): NodeProps<BlockGroupNode> {
  return {
    data: {
      blockId: "block",
      index: 0,
      name: "A".repeat(200),
      status: "pending",
      reserveFlowEntryStrip,
    },
  } as NodeProps<BlockGroupNode>;
}

describe("BlockGroupView", () => {
  test("keeps a long flow title out of the edge entry strip", () => {
    const { container } = render(<BlockGroupView {...groupProps(true)} />);
    const title = container.querySelector("p");

    expect(title?.classList.contains("truncate")).toBe(true);
    expect(title?.style.paddingRight).toBe(`${GRAPH_FLOW_ENTRY_STRIP}px`);
  });

  test("does not reserve the flow-only strip in the other layouts", () => {
    const { container } = render(<BlockGroupView {...groupProps(false)} />);
    const title = container.querySelector("p");

    expect(title?.classList.contains("truncate")).toBe(false);
    expect(title?.style.paddingRight).toBe("");
  });
});
