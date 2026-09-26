/**
 * A flow's level tag (`complexity:<level>`, written by the Workflow Management Flow) is split from
 * its subject tags: the level comes back as a level, and the subjects never contain it — nor any
 * other `complexity:` value, which is not a level.
 */

import { describe, expect, test } from "@jest/globals";
import { splitFlowTags } from "../../../packages/web-frontend/src/utils/workflow-level";

describe("splitFlowTags", () => {
  test("a flow without tags has no level and no subjects", () => {
    expect(splitFlowTags(undefined)).toEqual({ level: null, subjects: [] });
    expect(splitFlowTags([])).toEqual({ level: null, subjects: [] });
  });

  test("a flow with only subject tags keeps them all, in order, and has no level", () => {
    expect(splitFlowTags(["research", "verification"])).toEqual({
      level: null,
      subjects: ["research", "verification"],
    });
  });

  test.each(["simple", "standard", "complex"] as const)(
    "complexity:%s is the level, not a subject",
    (level) => {
      expect(splitFlowTags([`complexity:${level}`])).toEqual({ level, subjects: [] });
    },
  );

  test("an unknown complexity value is neither a level nor a subject", () => {
    expect(splitFlowTags(["complexity:extreme", "onboarding"])).toEqual({
      level: null,
      subjects: ["onboarding"],
    });
  });

  test("a level mixed with subject tags comes back apart from them, the subjects in order", () => {
    expect(splitFlowTags(["onboarding", "complexity:simple", "checklist", ""])).toEqual({
      level: "simple",
      subjects: ["onboarding", "checklist"],
    });
  });
});
