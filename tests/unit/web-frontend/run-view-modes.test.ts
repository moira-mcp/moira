/** @jest-environment jsdom */
/**
 * The two views both pages offer. The run page and the flow page each register exactly `map` and
 * `graph`, with the map as the default; every id either page used to have — and anything else a
 * deep link may carry — resolves to the map rather than failing. The run page's walkthrough is
 * anchored in those two views only: every step is reachable from whichever view is open, because
 * it either names a selector for that view or falls back to a view that does. After the redesign
 * the elements the walkthrough points at — the contents sidebar, the block panel, the return
 * ports, the route cursor and the toolbar — are drawn beside the graph as well as the map, so
 * every step names both views and no step drags the reader out of the view they chose.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_MODE,
  MODES,
  resolveMode,
  type RunViewMode,
} from "../../../packages/web-frontend/src/components/run/modes.js";
import {
  DEFAULT_FLOW_MODE,
  FLOW_MODES,
  resolveFlowMode,
} from "../../../packages/web-frontend/src/components/flow/modes.js";
import { GUIDE_STEPS } from "../../../packages/web-frontend/src/components/run/Walkthrough.js";
import { flowGuideSteps } from "../../../packages/web-frontend/src/components/flow/guideSteps.js";

/** Ids of views these pages used to have, plus values a hand-written link may carry. */
const RETIRED = ["lanes", "canvas", "outline", "route", "split", "", "Map", "nonsense"];

describe("view modes", () => {
  test("the run page registers exactly the map and the graph, the map first", () => {
    expect(MODES.map((mode) => mode.id)).toEqual(["map", "graph"]);
    expect(DEFAULT_MODE).toBe("map");
    expect(resolveMode("map")).toBe("map");
    expect(resolveMode("graph")).toBe("graph");
  });

  test("the flow page registers the same two ids with the same default", () => {
    expect(FLOW_MODES.map((mode) => mode.id)).toEqual(["map", "graph"]);
    expect(DEFAULT_FLOW_MODE).toBe("map");
    expect(resolveFlowMode("map")).toBe("map");
    expect(resolveFlowMode("graph")).toBe("graph");
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

describe("the run page's walkthrough", () => {
  const ids = MODES.map((mode) => mode.id);

  test("names no view that is not registered", () => {
    expect(GUIDE_STEPS.length).toBeGreaterThan(0);
    for (const step of GUIDE_STEPS) {
      expect(Object.keys(step.targets)).not.toHaveLength(0);
      for (const mode of Object.keys(step.targets)) expect(ids).toContain(mode);
      expect(ids).toContain(step.fallbackView);
    }
  });

  test("every step is anchored from whichever view is open", () => {
    for (const mode of ids as RunViewMode[]) {
      for (const step of GUIDE_STEPS) {
        const reachable = step.targets[mode] ?? step.targets[step.fallbackView];
        expect(reachable).toBeTruthy();
      }
    }
  });

  test("each step anchors the element of the redesigned interface it explains", () => {
    const byId = new Map(GUIDE_STEPS.map((step) => [step.id, step]));
    // A contents row: the block's status icon, its index badge and its counts.
    expect(byId.get("process")?.targets.map).toBe(
      '[data-testid="map-contents-list"] [data-block-id]',
    );
    // A return port on a card, not the retired transition chip.
    expect(byId.get("loop")?.targets.map).toBe('[data-port-kind="return"]');
    expect(byId.get("route")?.targets.map).toBe('[data-testid="run-cursor"]');
    expect(byId.get("route")?.needsRoute).toBe(true);
    // The step about exploring points at the toolbar, which carries both the view switch and the
    // layout presets it describes.
    // Each diagram mounts its own toolbar, so the step names the one of the open view.
    expect(byId.get("explore")?.targets.map).toBe('[data-testid="map-toolbar"]');
    expect(byId.get("explore")?.targets.graph).toBe('[data-testid="graph-toolbar"]');
  });

  test("anchors every step in the graph as well as the map, so no step forces a view switch", () => {
    for (const step of GUIDE_STEPS) {
      expect(step.targets.map).toBeTruthy();
      expect(step.targets.graph).toBeTruthy();
    }
  });
});

describe("the flow page's walkthrough", () => {
  const ids = FLOW_MODES.map((mode) => mode.id);

  test("names no view that is not registered and anchors every step in both", () => {
    const steps = flowGuideSteps(true);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(ids).toContain(step.fallbackView);
      for (const mode of Object.keys(step.targets)) expect(ids).toContain(mode);
      expect(step.targets.map).toBeTruthy();
      expect(step.targets.graph).toBeTruthy();
    }
  });

  test("points the editing step at the edit toggle for an owner and at the header for a reader", () => {
    const stepOf = (isOwner: boolean) =>
      flowGuideSteps(isOwner).find((step) => step.id === "edit")!.targets.map;
    expect(stepOf(true)).toBe('[data-testid="flow-edit-toggle"]');
    expect(stepOf(false)).toBe('[data-testid="flow-header"]');
  });

  test("explains the same vocabulary as the run page: the contents, a return port, the toolbar", () => {
    const byId = new Map(flowGuideSteps(false).map((step) => [step.id, step]));
    expect(byId.get("process")?.targets.map).toBe(
      '[data-testid="map-contents-list"] [data-block-id]',
    );
    expect(byId.get("loop")?.targets.map).toBe('[data-port-kind="return"]');
    expect(byId.get("explore")?.targets.map).toBe('[data-testid="map-toolbar"]');
    expect(byId.get("explore")?.targets.graph).toBe('[data-testid="graph-toolbar"]');
  });
});
