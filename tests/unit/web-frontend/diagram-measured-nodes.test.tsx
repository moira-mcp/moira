/** @jest-environment jsdom */
/**
 * The diagrams rebuild their node objects whenever what a card shows changes, and React Flow keeps
 * a node's measured size on the object it was given. `useMeasuredNodes` carries the last size React
 * Flow reported onto every rebuilt object, so a rebuild never hands React Flow an unmeasured node
 * it would have to wait for its ResizeObserver to measure again — the wait that, on a slow machine,
 * could leave the whole diagram unmeasured and every camera move queued behind it.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { Node, NodeChange } from "@xyflow/react";
import { useMeasuredNodes } from "../../../packages/web-frontend/src/components/diagram/measuredNodes.js";

const card = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
});

describe("useMeasuredNodes", () => {
  test("a rebuilt node carries the size React Flow last reported for it; an unreported one arrives as given", () => {
    const { result, rerender } = renderHook(({ nodes }) => useMeasuredNodes(nodes, undefined), {
      initialProps: { nodes: [card("a"), card("b")] },
    });
    // Nothing reported yet: the objects pass through untouched.
    expect(result.current.nodes?.map((node) => node.measured)).toEqual([undefined, undefined]);
    act(() =>
      result.current.onNodesChange([
        { id: "a", type: "dimensions", dimensions: { width: 462, height: 101 } },
      ]),
    );
    // The diagram rebuilds its nodes (a new selection, a walkthrough step): fresh objects.
    const rebuilt = [card("a"), card("b")];
    rerender({ nodes: rebuilt });
    expect(result.current.nodes?.[0].measured).toEqual({ width: 462, height: 101 });
    expect(result.current.nodes?.[1]).toBe(rebuilt[1]);
  });

  test("a size the node declares itself wins, and a removed node's size is forgotten", () => {
    const { result, rerender } = renderHook(({ nodes }) => useMeasuredNodes(nodes, undefined), {
      initialProps: { nodes: [card("frame")] },
    });
    act(() =>
      result.current.onNodesChange([
        { id: "frame", type: "dimensions", dimensions: { width: 100, height: 50 } },
      ]),
    );
    // The layout fixed a new frame size: what it declares is not overwritten by the old report.
    const declared = card("frame", { measured: { width: 900, height: 300 } });
    rerender({ nodes: [declared] });
    expect(result.current.nodes?.[0]).toBe(declared);
    act(() => result.current.onNodesChange([{ id: "frame", type: "remove" }]));
    rerender({ nodes: [card("frame")] });
    expect(result.current.nodes?.[0].measured).toBeUndefined();
  });

  test("the caller's own change handler still receives every change", () => {
    const received: NodeChange[][] = [];
    const handler = jest.fn((changes: NodeChange[]) => received.push(changes));
    const { result } = renderHook(() => useMeasuredNodes([card("a")], handler));
    const changes: NodeChange[] = [
      { id: "a", type: "dimensions", dimensions: { width: 10, height: 20 } },
    ];
    act(() => result.current.onNodesChange(changes));
    expect(received).toEqual([changes]);
  });
});
