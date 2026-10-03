import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { resolveBlockList } from "./execution-progress-lists.js";

export const PROGRESS_SUMMARY_LIST_WINDOW = 5;

/** The current projection's storage dependencies, independent of a repository or transport. */
export interface ProgressReadDependencies {
  variables: string[] | null;
  historyRoots: string[];
  arrayWindows: Array<{
    name: string;
    start: number;
    size: number;
  }>;
}

/**
 * Conservative template dependencies: helper arguments, nested paths and dynamic indices all
 * contribute names. Extra names from literals cost no data when absent. A variable-bag template
 * explicitly needs the whole bag. Runtime template fragments are expanded by repeated calls
 * with the values already loaded; plain data containing braces may over-select but never renders
 * differently or becomes executable.
 */
export function progressReadDependencies(
  workflow: WorkflowGraph,
  loadedVariables: Record<string, unknown> = {},
): ProgressReadDependencies {
  const names = new Set<string>();
  const historyRoots = new Set<string>();
  const counterRoots = new Set<string>();
  let all = false;
  const templates: string[] = [];
  if (workflow.progress?.title) templates.push(workflow.progress.title);
  for (const block of workflow.progress?.nodes ?? []) {
    templates.push(block.label);
    for (const field of ["items", "current", "done", "total"] as const) {
      const path = block.list?.[field];
      if (!path) continue;
      const root = path.split(/[.[]/u)[0];
      names.add(root);
      if (field !== "items") counterRoots.add(root);
      if (field === "current") {
        historyRoots.add(root);
        const local = /^([^.[]+)\.([^.[]+)/u.exec(path);
        if (local) historyRoots.add(`${local[1]}.${local[2]}`);
      }
    }
  }
  for (const node of workflow.nodes) {
    if (node.progressActiveLabel) templates.push(node.progressActiveLabel);
  }
  const expanded = new Set<string>();
  const templateNames = new Set<string>();
  for (let index = 0; index < templates.length; index++) {
    for (const match of templates[index].matchAll(/(?<!\\)\{\{([^{}]*)\}\}/gu)) {
      const expression = match[1];
      if (/\bcontext\.variables\b/u.test(expression)) all = true;
      for (const token of expression.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/gu)) {
        names.add(token[0]);
        templateNames.add(token[0]);
      }
    }
    for (const name of names) {
      if (expanded.has(name)) continue;
      expanded.add(name);
      const value = Object.hasOwn(loadedVariables, name)
        ? loadedVariables[name]
        : workflow.variableRegistry?.[name]?.default;
      if (typeof value === "string" && value.includes("{{")) templates.push(value);
    }
  }
  const lists = workflow.progress?.nodes.flatMap((node) => (node.list ? [node.list] : [])) ?? [];
  const arrayWindows = all
    ? []
    : lists.flatMap((list) => {
        const name = list.items;
        if (
          !name ||
          !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name) ||
          templateNames.has(name) ||
          counterRoots.has(name) ||
          lists.filter((candidate) => candidate.items === name).length > 1
        )
          return [];
        const defaults = Object.fromEntries(
          Object.entries(workflow.variableRegistry ?? {}).map(([key, definition]) => [
            key,
            definition.default,
          ]),
        );
        const resolved = resolveBlockList(
          list,
          { ...defaults, ...loadedVariables },
          new Map(),
        ).list;
        const length = resolved?.items?.length ?? 0;
        const start = Math.min(
          Math.max(0, (resolved?.current ?? 0) - Math.floor(PROGRESS_SUMMARY_LIST_WINDOW / 2)),
          Math.max(0, length - PROGRESS_SUMMARY_LIST_WINDOW),
        );
        return [{ name, start, size: PROGRESS_SUMMARY_LIST_WINDOW }];
      });
  return { variables: all ? null : [...names], historyRoots: [...historyRoots], arrayWindows };
}
