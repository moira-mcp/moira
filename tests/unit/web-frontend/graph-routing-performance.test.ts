import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";

interface Metric {
  preset: string;
  milliseconds: number;
  routes: number;
}

describe("graph routing performance", () => {
  test("lays out a realistic 300-card fan-in graph within the interactive budget", () => {
    const benchmark = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("tests/unit/web-frontend/helpers/graph-routing-benchmark.ts"),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    expect(benchmark.error).toBeUndefined();
    expect(benchmark.status).toBe(0);
    const metrics = JSON.parse(benchmark.stdout.trim()) as Metric[];

    expect(metrics.map((metric) => metric.preset)).toEqual([
      "default",
      "compact",
      "flow",
      "vertical",
    ]);
    for (const metric of metrics) {
      expect(metric.routes).toBeGreaterThanOrEqual(299);
      // The old per-edge grid build + sorted frontier took about eight seconds in default,
      // compact and flow. Four seconds keeps CI headroom while still distinguishing it.
      expect(metric.milliseconds).toBeLessThan(4_000);
    }
  }, 35000);
});
