/**
 * The order the steps of a block are listed in — on the card's steps tooltip, in the step list and
 * in the finder.
 *
 * A block's node ids come from the process derivation in whatever order the workflow declares them,
 * which is not the order the agent walks them: a block whose `end` node is authored before the
 * notification that leads into it would otherwise be read back to front. `orderNodeIds` starts at
 * the steps nothing inside the block leads to and follows the connections from there, leaving
 * anything it cannot reach in its authored order.
 */

import { describe, expect, test } from "@jest/globals";
import { orderNodeIds } from "../../../packages/web-frontend/src/components/run/model.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types";

/** A workflow of bare nodes, each naming where its outputs go. */
function workflowOf(nodes: Record<string, string[]>): WorkflowGraph {
  return {
    id: "wf",
    metadata: { name: "Order", description: "", version: "1.0.0" },
    nodes: Object.entries(nodes).map(([id, targets]) => ({
      id,
      type: "agent-directive",
      connections: Object.fromEntries(targets.map((to, index) => [`out${index}`, to])),
    })),
  } as unknown as WorkflowGraph;
}

describe("the order of a block's steps", () => {
  test("starts at the step nothing in the block leads to, however the workflow declares them", () => {
    // The case the run page showed back to front: the block's `end` is authored first, the
    // notification that reaches it second.
    const workflow = workflowOf({ end: [], notify: ["end"] });
    expect(orderNodeIds(workflow, ["end", "notify"])).toEqual(["notify", "end"]);
  });

  test("follows the connections from the entry, not the declared order", () => {
    const workflow = workflowOf({ c: [], b: ["c"], a: ["b"] });
    expect(orderNodeIds(workflow, ["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  test("keeps every step exactly once when a branch rejoins", () => {
    const workflow = workflowOf({
      gate: ["left", "right"],
      left: ["join"],
      right: ["join"],
      join: [],
    });
    const order = orderNodeIds(workflow, ["join", "left", "right", "gate"]);
    expect(order).toEqual(["gate", "left", "join", "right"]);
    expect(new Set(order).size).toBe(order.length);
  });

  test("leaves the steps it cannot reach from an entry in their authored order, after it", () => {
    // `b` and `c` lead into each other, so neither is an entry and the walk never reaches them
    // from `a`; they keep the order the workflow declares.
    const workflow = workflowOf({ a: [], b: ["c"], c: ["b"] });
    expect(orderNodeIds(workflow, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(orderNodeIds(workflow, ["a", "c", "b"])).toEqual(["a", "c", "b"]);
  });

  test("ignores connections that leave the block, so a step reached only from outside starts one", () => {
    const workflow = workflowOf({ outside: ["inner"], inner: ["away"], away: [] });
    expect(orderNodeIds(workflow, ["inner"])).toEqual(["inner"]);
  });

  test("returns a block whose steps the workflow does not describe unchanged", () => {
    expect(orderNodeIds(undefined, ["one", "two"])).toEqual(["one", "two"]);
  });
});
