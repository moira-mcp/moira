/** @jest-environment jsdom */
/**
 * The primitives the map, the graph and the side panels share.
 *
 * `TemplateText` turns the `{{…}}` references of an authored directive into tokens that keep their
 * braces, so what the card shows is what the workflow says; inside a title the token drops its pill
 * and keeps the surrounding font. `Hint` is the one tooltip of the application: every hint is drawn
 * on the same theme-aware popover surface, so no bubble arrives in the browser's own colours, and a
 * hint with nothing to say renders its trigger alone rather than an empty card. `PanelSection`
 * folds and remembers its state, and unfolds itself when the page sends the reader into it.
 */

import { describe, expect, test, beforeAll, afterEach } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import React from "react";
import i18n from "../../../packages/web-frontend/src/i18n";
import { Hint, HintBody } from "../../../packages/web-frontend/src/components/diagram/Hint";
import { PanelSection } from "../../../packages/web-frontend/src/components/diagram/PanelSection";
import {
  TemplateText,
  VariableProvider,
} from "../../../packages/web-frontend/src/components/diagram/VariableText";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function view(node: React.ReactElement): void {
  render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

describe("authored text with its variable references", () => {
  const REGISTRY = { attempts: { type: "number", description: "How many tries so far" } };

  test("draws every reference as a token that keeps the braces the workflow wrote", () => {
    view(
      <VariableProvider value={{ registry: REGISTRY }}>
        <TemplateText text="Try {{attempts}} of {{limit}} now" />
      </VariableProvider>,
    );
    const tokens = document.querySelectorAll("[data-variable]");
    expect([...tokens].map((token) => token.textContent)).toEqual(["{{attempts}}", "{{limit}}"]);
    // The text around the references is untouched, so the sentence still reads as authored.
    expect(document.body.textContent).toBe("Try {{attempts}} of {{limit}} now");
  });

  test("marks a reference the workflow's registry does not declare", () => {
    view(
      <VariableProvider value={{ registry: REGISTRY }}>
        <TemplateText text="{{attempts}} {{limit}}" />
      </VariableProvider>,
    );
    const [known, unknown] = [...document.querySelectorAll("[data-variable]")];
    expect(known.className).not.toContain("line-through");
    expect(unknown.className).toContain("line-through");
  });

  test("reads a field of a step's answer against the step that returns it", () => {
    view(
      <VariableProvider value={{ registry: REGISTRY }}>
        <TemplateText text="{{attempts.count}}" />
      </VariableProvider>,
    );
    const token = document.querySelector("[data-variable]")!;
    expect(token.getAttribute("data-variable")).toBe("attempts");
    expect(token.textContent).toBe("{{attempts.count}}");
    expect(token.className).not.toContain("line-through");
  });

  test("inside a title a token drops its pill and keeps the line's own font", () => {
    view(
      <VariableProvider value={{ registry: REGISTRY }}>
        <TemplateText text="Attempt {{attempts}}" compact />
      </VariableProvider>,
    );
    const compact = document.querySelector("[data-variable]")!;
    expect(compact.className).toContain("underline");
    expect(compact.className).not.toContain("bg-primary/10");
    expect(compact.className).not.toContain("font-mono");
  });
});

describe("the one tooltip", () => {
  test("draws its content on the shared popover surface, not in the browser's own bubble", () => {
    view(
      <Hint content="Fit the diagram" open>
        <button type="button">fit</button>
      </Hint>,
    );
    const hint = document.querySelector('[data-slot="hint"]')!;
    expect(hint.textContent).toContain("Fit the diagram");
    // The surface follows the theme's popover tokens, so the hint is legible in either theme.
    expect(hint.className).toContain("bg-popover");
    expect(hint.className).toContain("text-popover-foreground");
    expect(hint.className).toContain("border-border");
    // The trigger keeps no native title, which the browser would draw beside this one.
    const trigger = document.querySelector("button")!;
    expect(trigger.textContent).toBe("fit");
    expect(trigger.getAttribute("title")).toBeNull();
  });

  test("keeps authored text as written when the hint is a monospace one, and titles it", () => {
    // The body is asserted on its own: the tooltip's positioning layer costs seconds per render
    // in jsdom, and it is the real browser's job anyway (the E2E pass opens these).
    view(<HintBody content={"line one\nline two"} title="directive" mono />);
    const body = document.querySelector("[data-hint-body]")!;
    expect(body.textContent).toContain("directive");
    const mono = body.querySelector(".font-mono")!;
    expect(mono.textContent).toBe("line one\nline two");
    expect(mono.className).toContain("whitespace-pre-wrap");
  });

  test("a rich hint keeps its content as markup rather than flattening it to text", () => {
    view(
      <HintBody
        content={
          <ol>
            <li>first step</li>
            <li>second step</li>
          </ol>
        }
        flush
      />,
    );
    const body = document.querySelector("[data-hint-body]")!;
    expect([...body.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "first step",
      "second step",
    ]);
    // A hint whose content brings its own padding is not padded twice.
    expect(body.className).not.toContain("px-3");
  });

  test("renders the trigger alone when there is nothing to say", () => {
    view(
      <Hint content="" open>
        <button type="button">bare</button>
      </Hint>,
    );
    expect(screen.getByRole("button", { name: "bare" })).toBeDefined();
    expect(document.querySelector('[data-slot="hint"]')).toBeNull();
  });
});

describe("a foldable panel section", () => {
  test("folds and unfolds on its header and remembers the choice per section", () => {
    view(
      <PanelSection id="returns" title="returns">
        <p>the fields</p>
      </PanelSection>,
    );
    expect(screen.getByText("the fields")).toBeDefined();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("the fields")).toBeNull();
    expect(window.localStorage.getItem("moira.panel.folded:returns")).toBe("1");
  });

  test("unfolds itself when the page sends the reader into a folded section", () => {
    // Clicking a list item on the card opens the block's list section at that item: arriving at a
    // section the reader had folded must show it, not land behind a closed header.
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <PanelSection id="list" title="list" defaultOpen={false}>
          <p>the items</p>
        </PanelSection>
      </I18nextProvider>,
    );
    expect(screen.queryByText("the items")).toBeNull();
    rerender(
      <I18nextProvider i18n={i18n}>
        <PanelSection id="list" title="list" defaultOpen={false} openToken={1}>
          <p>the items</p>
        </PanelSection>
      </I18nextProvider>,
    );
    expect(screen.getByText("the items")).toBeDefined();
  });
});
