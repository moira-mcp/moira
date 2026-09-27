/**
 * A notification is read by a person, often on a phone, who can open neither a file on the agent's
 * machine nor a node's raw output. This warning flags message templates that would put such an
 * internal value in front of them: a path or file, a bare index or counter with nothing naming what
 * it counts, or a node's output that is neither a link nor a title. It is a heuristic over names
 * and descriptions, so it only warns; it never blocks saving.
 */

import type { UnifiedValidationIssue } from "@mcp-moira/shared";
import { SYSTEM_TEMPLATE_VARIABLES } from "../templates/system-variables.js";
import type { VariableRegistry } from "../types/graph-nodes.js";

const PATH_NAME = /(?:^|_)(?:path|file|dir|directory)$/iu;
const PATH_DESCRIPTION =
  /\b(?:file ?path|path to (?:the |a )?(?:file|folder|directory)|directory|folder|file on disk)\b/iu;
const COUNTER_NAME = /(?:_index$|_revision$|^max_|^current_step$)/iu;
const TITLE_NAME = /(?:title|name|label|summary)/iu;
const LINK_OR_TITLE = /(?:url|link|title|name|label|summary)/iu;
/**
 * `./x`, `../x`, `~/x`, or a multi-segment relative or absolute path ending in a file extension.
 * The first segment of the last form has no dot and the extension starts with a letter, so a
 * fraction (`1.2/1.3`), an abbreviation (`e.g./i.e.`) or a host (`www.example.com/page.html`) is
 * not a path.
 */
const LITERAL_PATH =
  /(?:^|[\s(`'"])((?:\.{1,2}\/|~\/|\/?[\w-]+\/[\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b)[\w./-]*)/u;

/** Every `{{…}}` value reference of a template, outside block-helper syntax and `this`. */
function valueReferences(template: string): string[] {
  const references: string[] = [];
  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const path = match[1];
    const root = path.split(".")[0];
    if (root === "this" || root === "else" || SYSTEM_TEMPLATE_VARIABLES.has(root)) continue;
    references.push(path);
  }
  return references;
}

/** The message's own text, with every template expression removed. */
function literalText(template: string): string {
  const parts: string[] = [];
  let expressionStart = -1;
  let literalStart = 0;

  for (let index = 0; index < template.length - 1; index++) {
    if (template[index] === "{" && template[index + 1] === "{") {
      // Keep the first opening pair, as the former expression matcher did.
      if (expressionStart < 0) expressionStart = index;
      index++;
    } else if (template[index] === "}") {
      if (template[index + 1] === "}" && expressionStart >= 0) {
        parts.push(template.slice(literalStart, expressionStart), " ");
        index++;
        literalStart = index + 1;
      } else if (template[index + 1] === "}") {
        index++;
      }
      expressionStart = -1;
    }
  }

  parts.push(template.slice(literalStart));
  return parts.join("");
}

function lastSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

/**
 * Warnings for one notification node's `message`. `nodeIds` names the graph's nodes, so a
 * `{{node-id.field}}` reference can be told from a dotted global.
 */
export function notificationContentWarnings(
  nodeId: string,
  message: string,
  nodeIds: ReadonlySet<string>,
  registry: VariableRegistry | undefined,
): UnifiedValidationIssue[] {
  const issues: UnifiedValidationIssue[] = [];
  const warn = (text: string): void => {
    issues.push({ type: "node", severity: "warning", nodeId, field: "message", message: text });
  };
  const references = valueReferences(message);
  const hasTitle = references.some((path) => TITLE_NAME.test(lastSegment(path)));
  const seen = new Set<string>();
  for (const path of references) {
    if (seen.has(path)) continue;
    seen.add(path);
    const root = path.split(".")[0];
    const field = lastSegment(path);
    const description = String(
      (registry?.[root] as { description?: unknown } | undefined)?.description ?? "",
    );
    if (PATH_NAME.test(field) || (path === root && PATH_DESCRIPTION.test(description))) {
      warn(
        `Notification ${nodeId} shows {{${path}}}, a file or path: the reader cannot open it from a message. Say what it contains in words, or link a URL.`,
      );
      continue;
    }
    if (nodeIds.has(root) && path !== root && !LINK_OR_TITLE.test(field)) {
      warn(
        `Notification ${nodeId} shows {{${path}}}, a step's raw output: show a title, a sentence or a URL instead.`,
      );
      continue;
    }
    if (COUNTER_NAME.test(field) && !hasTitle) {
      warn(
        `Notification ${nodeId} shows {{${path}}}, a bare number: name what it counts with a title next to it, or rely on the plan list the notification already carries.`,
      );
    }
  }
  const literal = LITERAL_PATH.exec(literalText(message));
  if (literal) {
    warn(
      `Notification ${nodeId} contains the path "${literal[1].replace(/\.+$/u, "")}": the reader cannot open it from a message. Describe the result in words, or link a URL.`,
    );
  }
  return issues;
}
