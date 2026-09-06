/**
 * One place that answers "what kind of node type is this?", so that every consumer gives the same
 * answer about the same workflow.
 *
 * The distinction that keeps getting collapsed is between "this installation does not have the
 * extension" and "this copy cannot tell". Collapsing them turns a workflow written for another
 * installation — or validated by a tool that cannot reach the registry — into a broken workflow.
 * Four outcomes exist, and consumers must map them to their own severities rather than re-deriving
 * them from a registry lookup.
 */

import { isBuiltinNodeType } from "../types/graph-nodes.js";
import { extensionNameOf, isExtensionNodeType } from "./extension-contract.js";
import type { ExtensionRegistry } from "./extension-registry.js";

export type NodeTypeClassification =
  /** A built-in node type of this engine. */
  | { kind: "builtin"; nodeType: string }
  /** A custom type whose extension is installed here. */
  | { kind: "extension-installed"; nodeType: string; extensionName: string }
  /** A custom type this caller cannot resolve: no registry, or a snapshot that may be stale. */
  | { kind: "extension-unresolvable"; nodeType: string; extensionName: string; reason: string }
  /** A custom type the live registry positively does not have. */
  | { kind: "extension-missing"; nodeType: string; extensionName: string }
  /** Neither built-in nor namespaced: a typo or a type from nowhere. */
  | { kind: "unknown"; nodeType: string };

export function classifyNodeType(
  nodeType: string,
  registry: ExtensionRegistry | null | undefined,
): NodeTypeClassification {
  if (isBuiltinNodeType(nodeType)) {
    return { kind: "builtin", nodeType };
  }

  if (!isExtensionNodeType(nodeType)) {
    return { kind: "unknown", nodeType };
  }

  const extensionName = extensionNameOf(nodeType) ?? nodeType;

  if (!registry) {
    return {
      kind: "extension-unresolvable",
      nodeType,
      extensionName,
      reason: "no extension registry is available here",
    };
  }

  if (registry.has(nodeType)) {
    return { kind: "extension-installed", nodeType, extensionName };
  }

  if (registry.origin === "snapshot") {
    // A snapshot lists what was installed when it was written. A type absent from it may simply
    // predate or postdate that moment, so this copy cannot conclude the extension is absent.
    return {
      kind: "extension-unresolvable",
      nodeType,
      extensionName,
      reason: "the published registry snapshot does not list this type and may be out of date",
    };
  }

  if (registry.origin === "unreachable") {
    // A service is configured but has not answered this process, so the registry is empty for a
    // reason that says nothing about what the installation has. Reporting "not installed" here
    // breaks every valid workflow of an installation whose service starts a moment later.
    return {
      kind: "extension-unresolvable",
      nodeType,
      extensionName,
      reason: "the extension service has not answered this process",
    };
  }

  if (registry.origin === "unconfigured") {
    // The registry is empty because this installation has no extension service to ask, not because
    // the extension was looked for and not found. Saying "not installed" here would call a workflow
    // written for an installation that does have extensions broken.
    return {
      kind: "extension-unresolvable",
      nodeType,
      extensionName,
      reason: "no extension service is configured on this installation",
    };
  }

  return { kind: "extension-missing", nodeType, extensionName };
}

/** Human-readable sentence for a classification that a consumer wants to report. */
export function describeNodeTypeClassification(classification: NodeTypeClassification): string {
  switch (classification.kind) {
    case "builtin":
    case "extension-installed":
      return "";
    case "extension-unresolvable":
      return `type '${classification.nodeType}' belongs to extension '${classification.extensionName}', which cannot be resolved here (${classification.reason})`;
    case "extension-missing":
      return `type '${classification.nodeType}' belongs to extension '${classification.extensionName}', which is not currently installed`;
    case "unknown":
      return `unknown node type '${classification.nodeType}'`;
  }
}
