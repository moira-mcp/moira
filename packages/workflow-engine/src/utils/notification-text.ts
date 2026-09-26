/**
 * The text of a notification a person receives: a heading that names the flow and the task and
 * links to the run page, the author's message, the plan, and who the run waits for. Every piece
 * that does not come from the author's own markup is written for the message's format, so a task
 * note or an item title containing `_`, `*` or `<` reaches the reader as written instead of
 * breaking the parse. Pure except `runPageUrl`, which reads the configured host and base path
 * (`MOIRA_HOST`, `APP_BASE_PATH`); the sender resolves the run and the channel limit.
 */

import { getAppPrefix, getBaseUrl } from "@mcp-moira/shared";
import type { ExecutionContext } from "../types/base-types.js";
import type { TextEscaper } from "./execution-progress-lists.js";

export type NotificationFormat = "plain" | "markdown" | "html";

/** The longest task note the heading shows; longer notes are shortened with `…`. */
export const HEADING_NOTE_LIMIT = 200;

const escapeHtml: TextEscaper = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Text as it must stand outside an entity in a message of `format`: Telegram's legacy Markdown
 * treats `_ * \` [` as markup unless escaped with a backslash; HTML needs its entities.
 */
export function textEscaper(format: NotificationFormat | undefined): TextEscaper {
  if (format === "markdown") return (text) => text.replace(/([_*`[])/g, "\\$1");
  if (format === "html") return escapeHtml;
  return (text) => text;
}

/**
 * The run page of the run a node belongs to. An inline subgraph child has no page of its own, so
 * it links to the top-level run that carries it.
 */
export function runPageUrl(context: Pick<ExecutionContext, "executionId" | "_rootExecutionId">) {
  const executionId = context._rootExecutionId ?? context.executionId;
  return `${getBaseUrl()}${getAppPrefix()}/executions/${executionId}`;
}

/**
 * `<flow> · <task>` linked to the run page; the flow name alone, still linked, when the run has no
 * note. In legacy Markdown the link text takes no escapes (a backslash stays visible) and must not
 * contain square brackets, so brackets become parentheses there. Plain text has no links: the URL
 * follows on its own line.
 */
export function notificationHeading(
  flowName: string,
  note: string | null | undefined,
  url: string,
  format: NotificationFormat | undefined,
): string {
  const task = (note ?? "").replace(/\s+/g, " ").trim();
  const shortTask =
    task.length > HEADING_NOTE_LIMIT ? `${task.slice(0, HEADING_NOTE_LIMIT - 1)}…` : task;
  const title = shortTask ? `${flowName.trim()} · ${shortTask}` : flowName.trim();
  if (format === "markdown") {
    return `[${title.replace(/\[/g, "(").replace(/\]/g, ")")}](${url})`;
  }
  if (format === "html") return `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`;
  return `${title}\n${url}`;
}

export interface NotificationParts {
  heading: string;
  body: string;
  /** Renders the plan within a character budget; returns no lines when nothing fits. */
  planList: (budget: number) => string[];
  waitingLine: string | null;
  /** The channel's text limit. */
  limit: number;
}

/**
 * Heading, message, plan and waiting line, separated by blank lines. The plan takes the room the
 * rest leaves; if the message itself is too long for the channel it is cut at a line boundary and
 * ends with `…`, so a notification is never refused for its length.
 */
export function composeNotification(parts: NotificationParts): string {
  const join = (sections: ReadonlyArray<string | null>) =>
    sections.filter((section): section is string => Boolean(section)).join("\n\n");
  const fixed = [parts.heading, parts.waitingLine];
  let body = parts.body.trim();
  const room = (text: string) => parts.limit - join([...fixed, text]).length;
  if (room(body) < 0) {
    const keep = Math.max(0, body.length + room(body) - 2);
    const cut = body.slice(0, keep);
    const lineEnd = cut.lastIndexOf("\n");
    body = `${(lineEnd > keep / 2 ? cut.slice(0, lineEnd) : cut).trimEnd()}\n…`;
  }
  const planBudget = room(body) - 2;
  const plan = planBudget > 0 ? parts.planList(planBudget) : [];
  return join([parts.heading, body, plan.length ? plan.join("\n") : null, parts.waitingLine]);
}
