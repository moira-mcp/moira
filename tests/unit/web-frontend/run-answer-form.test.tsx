/** @jest-environment jsdom */
/**
 * The answer form turns drafts into the typed answer the waiting step's schema expects: numbers,
 * booleans and JSON objects or arrays are parsed by declared type, strings pass through, and
 * empty drafts are omitted rather than sent as empty values.
 */

import { describe, expect, test } from "@jest/globals";
import {
  buildAnswer,
  parseFieldValue,
} from "../../../packages/web-frontend/src/components/run/VariablesPanel.js";
import type { EvidenceField } from "../../../packages/web-frontend/src/components/run/model.js";

const field = (name: string, type: string | null, required = false): EvidenceField => ({
  name,
  type,
  description: null,
  required,
  enum: null,
});

describe("answer form value parsing", () => {
  test.each([
    [field("count", "number"), "3", 3],
    [field("count", "integer"), " 7 ", 7],
    [field("count", "number"), "", undefined],
    [field("ok", "boolean"), "true", true],
    [field("ok", "boolean"), "false", false],
    [field("ok", "boolean"), "", undefined],
    [field("meta", "object"), '{"a":1}', { a: 1 }],
    [field("items", "array"), "[1, 2]", [1, 2]],
    [field("meta", "object"), "", undefined],
    [field("note", "string"), "kept as typed ", "kept as typed "],
    [field("note", null), "", undefined],
  ])("parses %o from %j", (evidence, raw, expected) => {
    expect(parseFieldValue(evidence, raw)).toEqual(expected);
  });

  test("malformed JSON for an object field is an error, not a string", () => {
    expect(() => parseFieldValue(field("meta", "object"), "{not json")).toThrow();
  });

  test("the answer carries every non-empty field typed and omits empty ones", () => {
    const fields = [
      field("task_file", "string", true),
      field("total_steps", "number"),
      field("approved", "boolean"),
      field("extras", "array"),
    ];
    expect(
      buildAnswer(fields, {
        task_file: "./plan.md",
        total_steps: "5",
        approved: "true",
        extras: "",
      }),
    ).toEqual({ task_file: "./plan.md", total_steps: 5, approved: true });
    expect(buildAnswer(fields, {})).toEqual({});
  });
});
