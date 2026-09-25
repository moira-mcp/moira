/**
 * CLI argument parsing for the process block commands. The mutations themselves are the shared
 * authoring functions of `@mcp-moira/workflow-engine/authoring`, used by the browser editor too.
 */

import type { ProgressListBinding } from "@mcp-moira/workflow-engine";

/** Parse a `--list` value: a JSON binding object, or `none` to remove the binding. */
export function parseListBinding(value: string): ProgressListBinding | null {
  if (value === "none") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      '--list expects a JSON object such as {"items":"tasks","current":"current_task"}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--list expects a JSON object");
  }
  const binding = parsed as Record<string, unknown>;
  const allowed = new Set(["items", "title", "current", "done", "total", "indexBase"]);
  for (const key of Object.keys(binding)) {
    if (!allowed.has(key)) throw new Error(`--list: unknown field '${key}'`);
  }
  for (const key of ["items", "title", "current", "done", "total"]) {
    if (binding[key] !== undefined && (typeof binding[key] !== "string" || !binding[key])) {
      throw new Error(`--list: '${key}' must be a non-empty variable path`);
    }
  }
  if (binding.indexBase !== undefined && binding.indexBase !== 0 && binding.indexBase !== 1) {
    throw new Error("--list: 'indexBase' must be 0 or 1");
  }
  if (!binding.items && !binding.current && !binding.total) {
    throw new Error("--list needs at least one of items, current or total");
  }
  return binding as ProgressListBinding;
}
