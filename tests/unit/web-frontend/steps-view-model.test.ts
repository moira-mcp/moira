/** @jest-environment jsdom */
/**
 * The steps view reads a workflow as what the agent is told: numbered instructions in the order
 * they come, a label only where the way on is a choice, returns marked as returns, finish markers
 * for the ends. The learning examples are read from the shipped catalog files, so a change to
 * their routing shows here as a changed picture. `humanizeVariable` is how "variables as words"
 * names a variable; the recommendation registry decides which flows a newcomer is offered, in which
 * language, and which of them open on the steps view.
 */

import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  DIAGRAM_MAX_CARDS,
  stepsModel,
  stepsPresentation,
} from "../../../packages/web-frontend/src/components/flow/stepsModel.js";
import { humanizeVariable } from "../../../packages/web-frontend/src/components/diagram/VariableText.js";
import {
  preferredFlowView,
  recommendedFlows,
} from "../../../packages/web-frontend/src/components/onboarding/recommended.js";

const flowsDir = path.join(process.cwd(), "workflows/production/flows");
function catalogFlow(slug: string): { nodes: never[] } {
  for (const file of fs.readdirSync(flowsDir)) {
    const workflow = JSON.parse(fs.readFileSync(path.join(flowsDir, file), "utf8"));
    if (workflow.slug === slug) return workflow;
  }
  throw new Error(`no catalog flow ${slug}`);
}

describe("stepsModel", () => {
  test("a straight sequence is numbered instructions joined by unlabelled arrows", () => {
    const model = stepsModel(catalogFlow("example-simple-steps") as never);
    expect(model.cards.map((card) => [card.kind, card.number])).toEqual([
      ["start", null],
      ["instruction", 1],
      ["instruction", 2],
      ["instruction", 3],
      ["instruction", 4],
      ["finish", null],
    ]);
    expect(model.cards[1].text).toMatch(/^Read the user's request/);
    expect(model.edges.map((edge) => edge.label)).toEqual([null, null, null, null, null]);
    expect(model.edges.some((edge) => edge.back)).toBe(false);
  });

  test("a fork carries the authored answer labels on its ways out, in the reader's language", () => {
    const english = stepsModel(catalogFlow("example-one-choice") as never);
    const fork = english.edges.filter((edge) => edge.source === "check-result");
    expect(fork.map((edge) => [edge.label, edge.target])).toEqual([
      ["yes — it matches", "report"],
      ["no — something is missing", "explain-gap"],
    ]);
    expect(english.cards.filter((card) => card.kind === "finish")).toHaveLength(2);

    const russian = stepsModel(catalogFlow("example-one-choice-ru") as never);
    expect(
      russian.edges.filter((edge) => edge.source === "check-result").map((edge) => edge.label),
    ).toEqual(["да — совпадает", "нет — чего-то не хватает"]);
  });

  test("several paths keep one arrow per choice and one finish per path", () => {
    const model = stepsModel(catalogFlow("example-several-paths") as never);
    expect(
      model.edges.filter((edge) => edge.source === "sort-request").map((edge) => edge.label),
    ).toEqual(["a question", "a bug", "an idea"]);
    expect(model.cards.filter((card) => card.kind === "finish").map((card) => card.id)).toEqual([
      "end-answered",
      "end-fixed",
      "end-planned",
    ]);
  });

  test("a loop is one return arrow to the open step, not a second copy of the path", () => {
    const model = stepsModel({
      nodes: [
        { id: "start", type: "start", connections: { default: "work" } },
        {
          id: "work",
          type: "agent-directive",
          directive: "Do {{task}}",
          connections: { success: "review" },
        },
        {
          id: "review",
          type: "condition",
          connections: { true: "done", default: "work" },
          connectionLabels: {
            true: "passed",
            default: { label: "fix it", cycle: { cause: "c", exit: "e" } },
          },
        },
        { id: "done", type: "end" },
        { id: "unreachable", type: "teleport", connections: { success: "work" } },
      ],
    } as never);
    expect(model.cards.map((card) => card.id)).toEqual(["start", "work", "review", "done"]);
    expect(model.cards.find((card) => card.id === "review")?.kind).toBe("check");
    expect(model.edges.map((edge) => [edge.id, edge.label, edge.back])).toEqual([
      ["start.default", null, false],
      ["work.success", null, false],
      ["review.true", "passed", false],
      ["review.default", "fix it", true],
    ]);
  });

  test("a workflow with no start node has nothing to read", () => {
    expect(stepsModel({ nodes: [{ id: "end", type: "end" }] } as never)).toEqual({
      cards: [],
      edges: [],
    });
  });
});

describe("humanizeVariable", () => {
  test.each([
    ["current_task", "current task"],
    ["review.outcome", "outcome"],
    ["tasks[0].action", "action"],
    ["executionId", "execution id"],
    ["plan-revision", "plan revision"],
  ])("%s reads as %s", (name, words) => {
    expect(humanizeVariable(name)).toBe(words);
  });
});

describe("recommended flows", () => {
  test("offers the learning examples in the interface language, then the universal flows", () => {
    expect(recommendedFlows("en").map((flow) => [flow.slug, flow.level])).toEqual([
      ["example-simple-steps", 1],
      ["example-one-choice", 2],
      ["example-several-paths", 3],
      ["quick-task", null],
      ["robust-task", null],
      ["todo-list", null],
    ]);
    expect(
      recommendedFlows("ru-RU")
        .slice(0, 3)
        .map((flow) => flow.slug),
    ).toEqual(["example-simple-steps-ru", "example-one-choice-ru", "example-several-paths-ru"]);
  });

  test("opens the system's learning examples on the steps view and nothing else", () => {
    expect(preferredFlowView("moira", "example-one-choice")).toBe("steps");
    expect(preferredFlowView("moira", "example-one-choice-ru")).toBe("steps");
    expect(preferredFlowView("someone", "example-one-choice")).toBeNull();
    expect(preferredFlowView("moira", "quick-task")).toBeNull();
    expect(preferredFlowView(undefined, undefined)).toBeNull();
  });
});

describe("stepsPresentation", () => {
  test.each([
    "example-simple-steps",
    "example-simple-steps-ru",
    "example-one-choice",
    "example-one-choice-ru",
    "example-several-paths",
    "example-several-paths-ru",
    "todo-list",
  ])("%s stays a drawn diagram", (slug) => {
    expect(stepsPresentation(stepsModel(catalogFlow(slug) as never))).toBe("diagram");
  });

  test.each(["quick-task", "robust-task", "software-development-flow"])(
    "%s reads as a list",
    (slug) => {
      const model = stepsModel(catalogFlow(slug) as never);
      expect(model.cards.length).toBeGreaterThan(DIAGRAM_MAX_CARDS);
      expect(stepsPresentation(model)).toBe("list");
    },
  );

  test("size decides, not returns: a small flow with a loop is still drawn", () => {
    const todo = stepsModel(catalogFlow("todo-list") as never);
    expect(todo.edges.some((edge) => edge.back)).toBe(true);
    expect(stepsPresentation(todo)).toBe("diagram");
  });
});
