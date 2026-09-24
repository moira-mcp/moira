/**
 * @jest-environment jsdom
 *
 * The steps view's reading list ends every card with its way on, from the steps model: a single
 * way reads "Next:" with a link to the step, a fork lists each authored choice with a link to the
 * step it leads to, and a return reads "back to step N" with a link to that step. Links are
 * anchors to the cards, so the list can be followed through a long flow.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { StepsList } from "../../../packages/web-frontend/src/components/flow/StepsList";
import { stepsModel } from "../../../packages/web-frontend/src/components/flow/stepsModel";

afterEach(() => cleanup());

// Draft, then review: approved finishes, changes go back to the draft
const WORKFLOW = {
  nodes: [
    { id: "start", type: "start", connections: { default: "draft" } },
    {
      id: "draft",
      type: "agent-directive",
      directive: "Write the draft.",
      connections: { success: "review" },
    },
    {
      id: "review",
      type: "agent-directive",
      directive: "Review the draft.",
      connections: { approved: "done", changes: "draft" },
      connectionLabels: { approved: "approved", changes: "needs changes" },
    },
    { id: "done", type: "end" },
  ],
};

function card(id: string): HTMLElement {
  return document.querySelector(`[data-testid="steps-card"][data-node-id="${id}"]`) as HTMLElement;
}

describe("StepsList", () => {
  test("each card ends with its way on: next, labelled choices, and back to a numbered step", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StepsList model={stepsModel(WORKFLOW as never)} inline />
      </I18nextProvider>,
    );

    const draft = within(card("draft")).getByTestId("steps-way-on");
    expect(draft).toHaveTextContent("Next: Step 2");
    expect(within(draft).getByTestId("steps-way")).toHaveAttribute("href", "#step-review");

    const review = within(card("review"));
    const choices = review.getAllByRole("listitem");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "approved→Finish",
      "needs changes→back to step 1",
    ]);
    const [finish, back] = review.getAllByTestId("steps-way");
    expect(finish).toHaveAttribute("href", "#step-done");
    expect(back).toHaveAttribute("href", "#step-draft");
    expect(back).toHaveAttribute("data-back", "true");

    // Every card is an anchor target with the steps view's test id and kind
    expect(screen.getAllByTestId("steps-card").map((element) => element.id)).toEqual([
      "step-start",
      "step-draft",
      "step-review",
      "step-done",
    ]);
  });

  test("a link to a check names it by its place, and a return to it says where it goes back to", () => {
    // Moira checks a condition; if work remains, do it and come back to the check
    const workflow = {
      nodes: [
        { id: "start", type: "start", connections: { default: "check" } },
        {
          id: "check",
          type: "condition",
          connections: { more: "work", done: "end" },
          connectionLabels: { more: "work remains", done: "all done" },
        },
        {
          id: "work",
          type: "agent-directive",
          directive: "Do the next item.",
          connections: { success: "check" },
        },
        { id: "end", type: "end" },
      ],
    };
    render(
      <I18nextProvider i18n={i18n}>
        <StepsList model={stepsModel(workflow as never)} inline />
      </I18nextProvider>,
    );
    expect(within(card("start")).getByTestId("steps-way")).toHaveTextContent(
      "Moira checks a condition, before step 1",
    );
    const back = within(card("work")).getByTestId("steps-way");
    expect(back).toHaveTextContent("back to: Moira checks a condition, before step 1");
    expect(back).toHaveAttribute("data-back", "true");
    // The check's own card keeps its short name
    expect(card("check")).toHaveTextContent(/^Moira checks a condition/);
  });

  test("a step's number and name are a heading, and every card can take focus", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StepsList model={stepsModel(WORKFLOW as never)} inline />
      </I18nextProvider>,
    );
    // The number badge is decoration: the heading's accessible name is the step's name
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["1Step 1", "2Step 2"]);
    for (const heading of headings)
      expect(heading.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^\d+$/);
    expect(screen.getByRole("heading", { name: "Step 1" })).toBeInTheDocument();
    for (const element of screen.getAllByTestId("steps-card"))
      expect(element).toHaveAttribute("tabindex", "-1");
  });

  test("two rows that would read alike get their order, so every link names one place", () => {
    // Two of Moira's own steps between the start and step 1
    const workflow = {
      nodes: [
        { id: "start", type: "start", connections: { default: "files" } },
        { id: "files", type: "materialize", connections: { default: "more-files" } },
        { id: "more-files", type: "materialize", connections: { default: "work" } },
        {
          id: "work",
          type: "agent-directive",
          directive: "Work.",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    render(
      <I18nextProvider i18n={i18n}>
        <StepsList model={stepsModel(workflow as never)} inline />
      </I18nextProvider>,
    );
    const first = within(card("start")).getByTestId("steps-way").textContent;
    const second = within(card("files")).getByTestId("steps-way").textContent;
    expect(first).toMatch(/, before step 1$/);
    expect(second).toBe(`${first} (#2)`);
  });
});
