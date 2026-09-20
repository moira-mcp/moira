import { performance } from "node:perf_hooks";
import {
  estimateStepHeight,
  GRAPH_PRESET_DIRECTIONS,
  graphSpacing,
  layoutGraph,
} from "../../../../packages/web-frontend/src/components/workflow/graphLayout";
import { LAYOUT_PRESETS } from "../../../../packages/web-frontend/src/components/diagram/layoutPreset";
import type { GraphModel } from "../../../../packages/web-frontend/src/components/run/graphModel";

const count = 300;
const ids = Array.from({ length: count }, (_, index) => `n${index}`);
const model: GraphModel = {
  steps: ids.map((id) => ({
    id,
    blockId: "large",
    step: { id, displayName: id, summary: "", evidence: [] },
    connections: [],
  })) as GraphModel["steps"],
  links: Array.from({ length: count - 1 }, (_, index) => [
    {
      id: `n${index}.next`,
      source: `n${index}`,
      target: `n${index + 1}`,
      label: "next",
      kind: "forward" as const,
    },
    {
      id: `n${index + 1}.back`,
      source: `n${index + 1}`,
      target: "n0",
      label: "back",
      kind: "return" as const,
    },
  ]).flat(),
  blocks: [
    {
      id: "large",
      index: 0,
      name: "Large",
      nodeIds: ids,
      transitions: [],
    },
  ] as GraphModel["blocks"],
};
const heights = new Map(
  ids.map((id, index) => {
    const inCount = index === 0 ? count - 1 : 1;
    const outCount = index === 0 || index === count - 1 ? 1 : 2;
    return [
      id,
      estimateStepHeight({
        summary: "",
        evidence: [],
        connectionCount: inCount + outCount,
        inCount,
        outCount,
      }),
    ];
  }),
);
const metrics: Array<{ preset: string; milliseconds: number; routes: number }> = [];

for (const preset of LAYOUT_PRESETS) {
  const directions = GRAPH_PRESET_DIRECTIONS[preset];
  const started = performance.now();
  const layout = await layoutGraph(
    model,
    directions.outer,
    heights,
    graphSpacing(preset),
    directions.inner,
  );
  const missing = ids.slice(1).filter((id) => !layout.routes[`${id}.back`]);
  if (missing.length > 0) throw new Error(`Missing return routes: ${missing.join(", ")}`);
  metrics.push({
    preset,
    milliseconds: performance.now() - started,
    routes: Object.keys(layout.routes).length,
  });
}

process.stdout.write(`${JSON.stringify(metrics)}\n`);
