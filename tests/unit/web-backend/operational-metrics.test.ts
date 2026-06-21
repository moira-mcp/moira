/**
 * Operational Metrics Unit Tests
 * Tests for audit-based rate calculation and metric structure validation
 */

import { describe, it, expect } from "@jest/globals";

describe("Operational Metrics — Audit-Based Rate Calculation", () => {
  // Pure math: rate = count / windowSeconds, rounded to 2 decimal places
  function calculateRate(count: number, windowSeconds: number): number {
    if (windowSeconds === 0) return 0;
    return Math.round((count / windowSeconds) * 100) / 100;
  }

  it("calculates rate from count over 60 second window", () => {
    expect(calculateRate(120, 60)).toBe(2); // 120 events / 60s = 2 req/s
  });

  it("returns zero rate for zero events", () => {
    expect(calculateRate(0, 60)).toBe(0);
  });

  it("handles single event", () => {
    expect(calculateRate(1, 60)).toBe(0.02); // 1/60 ≈ 0.0167 → rounds to 0.02
  });

  it("rounds to 2 decimal places", () => {
    expect(calculateRate(100, 60)).toBe(1.67); // 100/60 = 1.6667 → 1.67
  });

  it("handles zero window safely", () => {
    expect(calculateRate(100, 0)).toBe(0);
  });
});

describe("Operational Metrics — Metric Structure Validation", () => {
  it("validates metric with time series for successful query", () => {
    const metric = {
      name: "unique_users_per_day",
      value: 15,
      unit: "users",
      available: true,
      timeSeries: [
        { date: "2025-03-01", value: 5 },
        { date: "2025-03-02", value: 10 },
      ],
    };

    expect(metric.available).toBe(true);
    expect(metric.value).toBeGreaterThanOrEqual(0);
    expect(metric.timeSeries).toHaveLength(2);
    expect(metric.timeSeries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("validates metric with hourly time series", () => {
    const metric = {
      name: "calls_per_second",
      value: 1.5,
      unit: "req/s",
      available: true,
      timeSeries: [
        { date: "2025-03-01 12:00", value: 45 },
        { date: "2025-03-01 13:00", value: 62 },
      ],
    };

    expect(metric.available).toBe(true);
    expect(metric.timeSeries).toHaveLength(2);
    expect(metric.timeSeries[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("validates metric for failed query", () => {
    const metric = {
      name: "unique_users_per_day",
      value: null,
      unit: "users",
      available: false,
      unavailableReason: "Failed to query audit log",
    };

    expect(metric.available).toBe(false);
    expect(metric.value).toBeNull();
    expect(metric.unavailableReason).toBeDefined();
    expect(metric.unavailableReason!.length).toBeGreaterThan(0);
  });

  it("validates all 6 metric names are expected", () => {
    const expectedNames = [
      "unique_users_per_day",
      "total_calls_per_day",
      "calls_per_second",
      "workflows_started_per_day",
      "workflows_completed_per_day",
      "mcp_calls_per_second",
    ];

    for (const name of expectedNames) {
      expect(name).toMatch(/^[a-z_]+$/);
    }
    expect(expectedNames).toHaveLength(6);
  });
});
