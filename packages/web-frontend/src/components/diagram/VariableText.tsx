/**
 * Authored text with its variable references made interactive: `{{name}}` and `{{node.field}}`
 * in a directive, the identifiers of an expression (`attempts = attempts + 1`) and the
 * `contextPath` of a condition are drawn as tokens that name the variable, explain it from the
 * workflow's registry on hover and, when the surface offers it, jump to its definition on click.
 */

import React, { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Hint } from "./Hint";

export interface VariableDefinition {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: boolean;
}

export interface VariableContextValue {
  registry: Readonly<Record<string, VariableDefinition>>;
  /** Jump to the variable's definition; absent when the surface has nowhere to go. */
  onSelect?: (name: string) => void;
  /** The variable the reader selected: every reference to it is emphasised. */
  selected?: string | null;
}

const VariableContext = createContext<VariableContextValue>({ registry: {} });

export function VariableProvider({
  value,
  children,
}: {
  value: VariableContextValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <VariableContext.Provider value={value}>{children}</VariableContext.Provider>;
}

export function useVariables(): VariableContextValue {
  return useContext(VariableContext);
}

const TEMPLATE = /\{\{\s*([A-Za-z_][\w.-]*)(?:\[[^\]]*\])?[^}]*\}\}/g;
const IDENT = /[A-Za-z_][\w.-]*/g;
const KEYWORDS = new Set(["true", "false", "null", "and", "or", "not"]);

/** The registry name a reference resolves to: `node.field` reads the node-local part. */
function rootOf(name: string): string {
  return name.split(".")[0];
}

export function VariableRef({
  name,
  className,
  braces = false,
  compact = false,
}: {
  name: string;
  className?: string;
  /** Show the reference as authored, `{{name}}`, rather than the bare name. */
  braces?: boolean;
  /** Inside a title: no pill, the surrounding font, colour and a dotted underline only. */
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { registry, onSelect, selected } = useVariables();
  const root = rootOf(name);
  const definition = registry[root] ?? registry[name];
  const hasRegistry = Object.keys(registry).length > 0;
  const known = Boolean(definition) || !hasRegistry;
  const token = (
    <span
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={(event) => {
        if (!onSelect) return;
        event.stopPropagation();
        onSelect(root);
      }}
      className={cn(
        compact
          ? "underline decoration-dotted underline-offset-2"
          : "rounded px-1 font-mono text-[0.95em] leading-none",
        known
          ? compact
            ? "text-primary hover:decoration-solid"
            : "bg-primary/10 text-primary hover:bg-primary/20"
          : compact
            ? "text-muted-foreground line-through decoration-destructive/60"
            : "bg-muted text-muted-foreground line-through decoration-destructive/60",
        selected === root && "ring-1 ring-primary",
        onSelect && "cursor-pointer",
        className,
      )}
      data-variable={root}
    >
      {braces ? `{{${name}}}` : name}
    </span>
  );
  return (
    <Hint
      content={
        <>
          {definition ? (
            <>
              <b>{root}</b>
              {definition.type ? `: ${definition.type}` : ""}
              {definition.required ? ` · ${t("components.diagram.variable.required")}` : ""}
              {definition.enum ? `\nenum ${JSON.stringify(definition.enum)}` : ""}
              {definition.default !== undefined
                ? `\ndefault ${JSON.stringify(definition.default)}`
                : ""}
              {definition.description ? `\n${definition.description}` : ""}
              {name !== root
                ? `\n${t("components.diagram.variable.answerField", { field: name, node: root })}`
                : ""}
              {onSelect ? `\n\n${t("components.diagram.variable.clickToDefinition")}` : ""}
            </>
          ) : (
            <>
              <b>{name}</b>
              {`\n${t("components.diagram.variable.undeclared")}`}
            </>
          )}
        </>
      }
      mono
    >
      {token}
    </Hint>
  );
}

/**
 * A directive or message: `{{…}}` references become tokens that keep their braces, the rest
 * stays text; `compact` is for titles, where a pill would break the line.
 */
export function TemplateText({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TEMPLATE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<VariableRef key={`${index}`} name={match[1]} braces compact={compact} />);
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** An expression: every identifier that names a variable becomes a token. */
export function ExpressionText({ text }: { text: string }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(IDENT)) {
    const index = match.index ?? 0;
    const word = match[0];
    if (KEYWORDS.has(word) || /^\d/.test(word)) continue;
    // Not inside a string literal: a quote count before the identifier that is odd means inside.
    const before = text.slice(0, index);
    if ((before.match(/"/g)?.length ?? 0) % 2 === 1 || (before.match(/'/g)?.length ?? 0) % 2 === 1)
      continue;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<VariableRef key={`${index}`} name={word} />);
    last = index + word.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A structured condition as one readable line, its `contextPath` references as tokens. */
export function ConditionText({ when }: { when: unknown }): React.JSX.Element {
  return <>{renderCondition(when)}</>;
}

const OPERATOR_TEXT: Record<string, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
};

function renderValue(value: unknown, key: string): React.ReactNode {
  if (value && typeof value === "object" && "contextPath" in (value as object)) {
    return <VariableRef key={key} name={String((value as { contextPath: unknown }).contextPath)} />;
  }
  return <span key={key}>{JSON.stringify(value)}</span>;
}

function renderCondition(when: unknown, depth = 0): React.ReactNode[] {
  if (!when || typeof when !== "object") return [<span key="raw">{JSON.stringify(when)}</span>];
  const c = when as Record<string, unknown>;
  const op = String(c.operator ?? "");
  if (op === "and" || op === "or") {
    const items = Array.isArray(c.conditions) ? c.conditions : [];
    const out: React.ReactNode[] = [];
    items.forEach((item, i) => {
      if (i > 0) out.push(<span key={`op${depth}-${i}`}> {op} </span>);
      out.push(<span key={`g${depth}-${i}`}>({renderCondition(item, depth + 1)})</span>);
    });
    return out;
  }
  if (op === "not")
    return [
      <span key="not">not (</span>,
      ...renderCondition(c.condition, depth + 1),
      <span key="close">)</span>,
    ];
  if (op === "exists") return [<span key="ex">exists </span>, renderValue(c.value, "v")];
  return [
    renderValue(c.left, "l"),
    <span key="o"> {OPERATOR_TEXT[op] ?? op} </span>,
    renderValue(c.right, "r"),
  ];
}
