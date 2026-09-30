import { describe, expect, test } from "@jest/globals";
import { currentPersonWait } from "@mcp-moira/shared";

/**
 * The key a «waiting for you» notification is queued and matched under. It must name the wait the
 * stored run stands in — the agent's question by its id, a gate by the open visit it waits in — so
 * a repeated write finds the same key and a new wait gets a new one.
 */

const visits = JSON.stringify([
  { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
  { seq: 1, nodeId: "approve", exitKey: "success", waited: true, changes: {} },
  { seq: 2, nodeId: "approve", exitKey: null, waited: true, changes: {} },
  { seq: 3, nodeId: "approve", exitKey: null, adjusted: true, changes: {} },
]);

function row(overrides: Partial<Parameters<typeof currentPersonWait>[0]> = {}) {
  return {
    state: "running",
    currentNodeId: "approve",
    gateWaiting: true,
    awaitingUser: null,
    visits,
    ...overrides,
  };
}

describe("a run recorded before the route log existed", () => {
  test("keeps its gate key when a variable edit appends an adjusted visit", () => {
    const legacy = currentPersonWait(row({ visits: "[]" }))?.waitKey;
    const edited = currentPersonWait(
      row({
        visits: JSON.stringify([
          { seq: 0, nodeId: "approve", exitKey: null, adjusted: true, changes: { mode: "x" } },
        ]),
      }),
    )?.waitKey;
    expect(legacy).toBeDefined();
    expect(edited).toBe(legacy);
  });
});

describe("currentPersonWait", () => {
  test.each([
    ["a gate waits in its open visit, not an adjustment on top", row(), "gate:2"],
    [
      "the agent's question takes precedence over the gate",
      row({ awaitingUser: JSON.stringify({ id: "q-1", nodeId: "approve" }) }),
      "agent:q-1",
    ],
    [
      "a question asked on a node the run has left falls back to the gate",
      row({ awaitingUser: JSON.stringify({ id: "q-1", nodeId: "draft" }) }),
      "gate:2",
    ],
    ["an unmarked step waits for nobody", row({ gateWaiting: false }), null],
    ["a finished run waits for nobody", row({ state: "completed" }), null],
    ["an unreadable question is ignored", row({ awaitingUser: "{broken" }), "gate:2"],
  ])("%s", (_case, stored, expected) => {
    expect(currentPersonWait(stored)?.waitKey ?? null).toBe(expected);
  });
});
