/**
 * The execution error journal holds two kinds of fact, and one rule tells them apart.
 *
 * A refusal means the step did not happen: the answer was rejected and the run waits at the same
 * node. A degradation means the step happened without behaviour text it names. Every consumer that
 * answers "did this step fail" reads the journal through these helpers, so the distinction has one
 * implementation instead of a comparison copied at each caller.
 */

import { describe, expect, test } from "@jest/globals";
import { countRefusals, isRefusal, latestRefusal } from "@mcp-moira/shared";

const refusal = { errorType: "validation" as const, message: "schema mismatch" };
const handlerFailure = { errorType: "handler" as const, message: "handler threw" };
const degradation = { errorType: "degradation" as const, message: "playbook unavailable" };

describe("refusals in the execution error journal", () => {
  test("a degradation is the only entry kind that is not a refusal", () => {
    expect(isRefusal(refusal)).toBe(true);
    expect(isRefusal(handlerFailure)).toBe(true);
    expect(isRefusal({ errorType: "system" })).toBe(true);
    expect(isRefusal(degradation)).toBe(false);
  });

  test("counting skips degradations, so a degraded step does not read as a failure", () => {
    expect(countRefusals([degradation, degradation])).toBe(0);
    expect(countRefusals([refusal, degradation, handlerFailure])).toBe(2);
    expect(countRefusals(undefined)).toBe(0);
    expect(countRefusals([])).toBe(0);
  });

  test("the latest refusal is the message a consumer reports, not the latest entry", () => {
    // The degradation arrives after the refusal, which is exactly the ordering that made a
    // rejected answer report the wrong message.
    expect(latestRefusal([refusal, degradation])).toBe(refusal);
    expect(latestRefusal([refusal, handlerFailure])).toBe(handlerFailure);
    expect(latestRefusal([degradation])).toBeUndefined();
    expect(latestRefusal(undefined)).toBeUndefined();
  });
});
