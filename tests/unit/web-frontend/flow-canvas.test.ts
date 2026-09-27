/**
 * What a gesture on the flow page's graph means for the definition: a drag from an existing output
 * retargets it, a drag from the new-output port asks for a name, a drop where the output already
 * leads or from an unknown handle does nothing; "insert after" follows the step's primary output;
 * an edge's actions know whether it is a primary output.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import {
  NEW_OUTPUT_HANDLE,
  connectIntent,
  dropOnCanvasIntent,
  edgeActions,
  insertAfterEdge,
} from "../../../packages/web-frontend/src/components/flow/canvas.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

const quickTask = (): WorkflowGraph =>
  JSON.parse(JSON.stringify(findCatalogEntryBySlug("quick-task")!.graph)) as WorkflowGraph;

describe("drag to connect", () => {
  test.each([
    [
      "an existing output dropped on another step retargets it",
      { source: "create-plan", sourceHandle: "out:create-plan.success", target: "get-task" },
      {
        kind: "op",
        op: { kind: "set-connection", source: "create-plan", key: "success", target: "get-task" },
      },
    ],
    [
      "the new-output port asks for the output's name",
      { source: "create-plan", sourceHandle: NEW_OUTPUT_HANDLE, target: "final-review" },
      { kind: "name-output", source: "create-plan", target: "final-review" },
    ],
    [
      "an output dropped where it already leads changes nothing",
      { source: "create-plan", sourceHandle: "out:create-plan.success", target: "plan-review" },
      { kind: "none" },
    ],
    [
      "a handle of another step, or of no known output, changes nothing",
      { source: "create-plan", sourceHandle: "out:get-task.success", target: "get-task" },
      { kind: "none" },
    ],
    [
      "a drop on a step that does not exist changes nothing",
      { source: "create-plan", sourceHandle: NEW_OUTPUT_HANDLE, target: "ghost" },
      { kind: "none" },
    ],
  ])("%s", (_name, gesture, intent) => {
    expect(connectIntent(quickTask(), gesture)).toEqual(intent);
  });

  test("an output key with a hyphen is read whole from its handle", () => {
    expect(
      connectIntent(quickTask(), {
        source: "plan-review",
        sourceHandle: "out:plan-review.route-operating-mode-plan-approval",
        target: "present-plan",
      }),
    ).toEqual({
      kind: "op",
      op: {
        kind: "set-connection",
        source: "plan-review",
        key: "route-operating-mode-plan-approval",
        target: "present-plan",
      },
    });
  });
});

describe("drop on the empty canvas", () => {
  test.each([
    [
      "an existing output keeps its name",
      { source: "create-plan", sourceHandle: "out:create-plan.success" },
      { source: "create-plan", key: "success" },
    ],
    [
      "a new output is named in the dialog",
      { source: "create-plan", sourceHandle: NEW_OUTPUT_HANDLE },
      { source: "create-plan", key: null },
    ],
    [
      "an output the step does not have offers nothing",
      { source: "create-plan", sourceHandle: "out:create-plan.nothing" },
      null,
    ],
  ])("%s", (_name, gesture, intent) => {
    expect(dropOnCanvasIntent(quickTask(), gesture)).toEqual(intent);
  });
});

describe("insert after and edge actions", () => {
  test("insert after follows the primary output; an end step has none", () => {
    expect(insertAfterEdge(quickTask(), "create-plan")).toEqual({
      source: "create-plan",
      key: "success",
    });
    expect(insertAfterEdge(quickTask(), "check-steps-remaining")).toEqual({
      source: "check-steps-remaining",
      key: "default",
    });
    expect(insertAfterEdge(quickTask(), "end")).toBeNull();
  });

  test("an edge's actions name its parts and whether it is a primary output", () => {
    expect(edgeActions(quickTask(), "plan-review.success")).toEqual({
      source: "plan-review",
      key: "success",
      target: "repair-plan",
      protected: true,
    });
    expect(
      edgeActions(quickTask(), "plan-review.route-operating-mode-plan-approval"),
    ).toMatchObject({ protected: false });
    expect(edgeActions(quickTask(), "plan-review.nothing")).toBeNull();
  });
});
