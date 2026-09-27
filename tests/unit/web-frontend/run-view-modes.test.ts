/** @jest-environment jsdom */
/**
 * The views both pages offer. The run page registers exactly `map` and `graph`; the flow page adds
 * `steps`, the plain reading of a definition, before them. The map is the default of both, and a
 * page may name another default (the flow page does for the learning examples); every id either
 * page used to have — and anything else a deep link may carry — resolves to that default rather
 * than failing. Which of these views each guide step is drawn in is checked with the guides
 * themselves (`guides-registry.test.ts`).
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_MODE,
  MODES,
  resolveMode,
} from "../../../packages/web-frontend/src/components/run/modes.js";
import {
  DEFAULT_FLOW_MODE,
  FLOW_MODES,
  resolveFlowMode,
} from "../../../packages/web-frontend/src/components/flow/modes.js";

/** Ids of views these pages used to have, plus values a hand-written link may carry. */
const RETIRED = ["lanes", "canvas", "outline", "route", "split", "", "Map", "nonsense"];

describe("view modes", () => {
  test("the run page registers exactly the map and the graph, the map first", () => {
    expect(MODES.map((mode) => mode.id)).toEqual(["map", "graph"]);
    expect(DEFAULT_MODE).toBe("map");
    expect(resolveMode("map")).toBe("map");
    expect(resolveMode("graph")).toBe("graph");
  });

  test("the flow page registers the steps view before the same two, with the same default", () => {
    expect(FLOW_MODES.map((mode) => mode.id)).toEqual(["steps", "map", "graph"]);
    expect(DEFAULT_FLOW_MODE).toBe("map");
    expect(resolveFlowMode("steps")).toBe("steps");
    expect(resolveFlowMode("map")).toBe("map");
    expect(resolveFlowMode("graph")).toBe("graph");
    expect(resolveFlowMode("graph", "steps")).toBe("graph");
  });

  test.each([...RETIRED, null, undefined])("%p resolves to the page's own default", (value) => {
    expect(resolveFlowMode(value, "steps")).toBe("steps");
  });

  test.each([...RETIRED, null, undefined])("%p resolves to the map on both pages", (value) => {
    expect(resolveMode(value)).toBe("map");
    expect(resolveFlowMode(value)).toBe("map");
  });

  test("every mode has its own icon component", () => {
    for (const registry of [MODES, FLOW_MODES]) {
      for (const mode of registry) expect(typeof mode.icon).not.toBe("undefined");
      expect(new Set(registry.map((mode) => mode.icon)).size).toBe(registry.length);
    }
  });
});
