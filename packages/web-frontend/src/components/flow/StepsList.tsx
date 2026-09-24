/**
 * The steps view of a large flow: the same steps model read top to bottom as a list instead of a
 * drawn web.
 *
 * Every instruction is a numbered card at full reading width with its whole text; it ends with its
 * way on — the next step, the labelled choices each linked to the step it leads to, or "back to
 * step N" for a return. Checks Moira makes on its own and the engine's system nodes are compact
 * rows; start and finish are small markers. A link scrolls its target into view and marks it for a
 * moment, so a reader can follow a choice through a long flow without losing the thread.
 *
 * Cards keep the steps view's test id and kinds (`steps-card`, `data-step-kind`), so the
 * walkthrough's anchor and every assertion about instruction cards hold on either presentation.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, Cog, CornerUpLeft, Play, Split } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHighlightTarget, type HighlightRequest } from "../diagram/useHighlightTarget";
import { TemplateText } from "../diagram/VariableText";
import type { StepCard, StepEdge, StepsModel } from "./stepsModel";

function anchorOf(id: string): string {
  return `step-${id}`;
}

function cardSelector(id: string): string {
  return `[data-node-id="${id.replace(/["\\]/g, "\\$&")}"]`;
}

export function StepsList({
  model,
  inline,
}: {
  model: StepsModel;
  inline: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(model.cards.map((card) => [card.id, card])), [model]);
  const waysOut = useMemo(() => {
    const ways = new Map<string, StepEdge[]>();
    for (const edge of model.edges) ways.set(edge.source, [...(ways.get(edge.source) ?? []), edge]);
    return ways;
  }, [model]);
  const container = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<HighlightRequest | null>(null);
  // The shared "go to" mark; focus goes with it, so keyboard and screen-reader readers continue
  // from the card they went to
  useHighlightTarget(container, jump, cardSelector, undefined, { focus: true });

  /** The number of the first numbered step after each card, for naming a card that has none. */
  const nextNumber = useMemo(() => {
    const next = new Map<string, number>();
    let upcoming: number | null = null;
    for (const card of [...model.cards].reverse()) {
      if (upcoming !== null) next.set(card.id, upcoming);
      if (card.number !== null) upcoming = card.number;
    }
    return next;
  }, [model]);

  /** What a card is called on its own. */
  const kindName = useCallback(
    (card: StepCard): string => {
      if (card.number !== null) return t("pages.flowPage.steps.step", { number: card.number });
      if (card.kind === "finish") return t("pages.flowPage.steps.finish");
      if (card.kind === "start") return t("pages.flowPage.steps.start");
      if (card.kind === "check") return t("pages.flowPage.steps.check");
      return t(`pages.flowPage.steps.system.${card.nodeType}`, {
        defaultValue: t("pages.flowPage.steps.system.other"),
      });
    },
    [t],
  );

  /**
   * What a link to each card says: a step by its number; a check or one of Moira's own steps also
   * by where it stands in the list, since several read alike — and where two still read the same,
   * the later ones by their order.
   */
  const linkNames = useMemo(() => {
    const names = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const card of model.cards) {
      const name = kindName(card);
      const before = nextNumber.get(card.id);
      const placed =
        (card.kind === "check" || card.kind === "system") && before !== undefined
          ? t("pages.flowPage.steps.list.placed", { name, number: before })
          : name;
      const count = (seen.get(placed) ?? 0) + 1;
      seen.set(placed, count);
      names.set(
        card.id,
        count > 1 && card.number === null
          ? t("pages.flowPage.steps.list.nth", { name: placed, n: count })
          : placed,
      );
    }
    return names;
  }, [model, kindName, nextNumber, t]);
  const nameOf = useCallback(
    (card: StepCard | undefined): string => (card ? (linkNames.get(card.id) ?? "") : ""),
    [linkNames],
  );

  /** Bring a card into view, move focus to it, and mark it for a moment. */
  const go = useCallback((id: string) => {
    setJump((previous) => ({ name: id, token: (previous?.token ?? 0) + 1 }));
  }, []);

  // A link to a step (`#step-<id>`) opens the list at that step, on load and when the hash changes
  // in place; the hash is then dropped, so a later change of the model (a saved edit) does not pull
  // the reader back to it
  const cards = useRef(model.cards);
  cards.current = model.cards;
  useEffect(() => {
    const open = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (!hash.startsWith("step-")) return;
      const id = hash.slice("step-".length);
      if (!cards.current.some((card) => card.id === id)) return;
      go(id);
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [go]);

  const link = (edge: StepEdge, text: string): React.JSX.Element => (
    <a
      href={`#${anchorOf(edge.target)}`}
      onClick={(event) => {
        event.preventDefault();
        go(edge.target);
      }}
      className="font-medium text-primary underline-offset-4 hover:underline"
      data-testid="steps-way"
      data-target={edge.target}
      data-back={edge.back ? "true" : undefined}
    >
      {text}
    </a>
  );

  /** Where the reader goes from this card: next, a choice among labelled ways, or back. */
  const wayOn = (card: StepCard): React.JSX.Element | null => {
    const ways = waysOut.get(card.id) ?? [];
    if (ways.length === 0) return null;
    const target = (edge: StepEdge) => nameOf(byId.get(edge.target));
    const back = (edge: StepEdge) => {
      const card = byId.get(edge.target);
      return card?.number
        ? t("pages.flowPage.steps.backTo", { number: card.number })
        : t("pages.flowPage.steps.list.backToPlace", { place: nameOf(card) });
    };
    if (ways.length === 1 && !ways[0].label) {
      const [edge] = ways;
      return (
        <p className="text-xs text-muted-foreground" data-testid="steps-way-on">
          {edge.back ? (
            <span className="inline-flex items-center gap-1">
              <CornerUpLeft className="size-3" aria-hidden="true" />
              {link(edge, back(edge))}
            </span>
          ) : (
            <>
              {t("pages.flowPage.steps.list.next")} {link(edge, target(edge))}
            </>
          )}
        </p>
      );
    }
    return (
      <ul className="flex flex-col gap-1 text-xs" data-testid="steps-way-on">
        {ways.map((edge) => (
          <li
            key={edge.id}
            className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground"
          >
            {edge.label && <span className="text-foreground">{edge.label}</span>}
            <span aria-hidden="true">→</span>
            {edge.back ? (
              <span className="inline-flex items-center gap-1">
                <CornerUpLeft className="size-3" aria-hidden="true" />
                {link(edge, back(edge))}
              </span>
            ) : (
              link(edge, target(edge))
            )}
          </li>
        ))}
      </ul>
    );
  };

  const common = (card: StepCard) => ({
    id: anchorOf(card.id),
    // A link's target takes focus, without entering the tab order
    tabIndex: -1,
    "data-testid": "steps-card",
    "data-step-kind": card.kind,
    "data-node-id": card.id,
  });
  const focusClass = "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div ref={container} className="h-full overflow-y-auto" data-testid="steps-list">
      <ol className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        {model.cards.map((card) => {
          if (card.kind === "start" || card.kind === "finish") {
            const Icon = card.kind === "start" ? Play : CircleCheck;
            return (
              <li
                key={card.id}
                {...common(card)}
                className={cn(
                  "flex scroll-mt-4 flex-col gap-1 rounded-lg px-1 transition-shadow",
                  focusClass,
                )}
              >
                <span
                  className={cn(
                    "inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                    card.kind === "start"
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-success/50 bg-success/10 text-success dark:text-success-foreground",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {kindName(card)}
                </span>
                {wayOn(card)}
              </li>
            );
          }
          if (card.kind === "check" || card.kind === "system") {
            const Icon = card.kind === "check" ? Split : Cog;
            return (
              <li
                key={card.id}
                {...common(card)}
                className={cn(
                  "flex scroll-mt-4 flex-col gap-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground transition-shadow",
                  focusClass,
                )}
              >
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Icon className="size-3.5" aria-hidden="true" />
                  {kindName(card)}
                </span>
                {card.text && (
                  <span className="whitespace-pre-line [overflow-wrap:anywhere]">
                    <TemplateText text={card.text} inline={inline} />
                  </span>
                )}
                {wayOn(card)}
              </li>
            );
          }
          return (
            <li
              key={card.id}
              {...common(card)}
              className={cn(
                "flex scroll-mt-4 flex-col gap-2 rounded-xl border bg-card px-5 py-4 shadow-sm transition-shadow",
                focusClass,
              )}
            >
              <h2 className="inline-flex items-center gap-2 text-xs font-semibold text-primary">
                <span
                  className="inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground"
                  aria-hidden="true"
                >
                  {card.number}
                </span>
                {kindName(card)}
              </h2>
              <p
                className="whitespace-pre-line text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
                data-testid="steps-card-text"
              >
                <TemplateText text={card.text} inline={inline} />
              </p>
              {wayOn(card)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
