/**
 * The checks of the tutorial "Build your first flow": pure functions of a workflow definition, the
 * learning example it was copied from, and the few facts the page knows about the copy. Each returns
 * whether the lesson's result holds and the findings that say what does not, as stable codes with
 * the node, field and data they are about — never prose, so the page renders them in the reader's
 * language and the result never depends on the language of the flow or of what the person typed.
 *
 * The step a lesson adds is recognised by structure — the one agent step the example does not have
 * — so renaming it, or naming it anything at all, does not change a result.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";

export interface LessonFinding {
  code: string;
  nodeId?: string;
  field?: string;
  data?: Record<string, string | number>;
}

export interface LessonResult {
  passed: boolean;
  findings: LessonFinding[];
}

/** What the page knows about the copy besides its definition. */
export interface CopyFacts {
  visibility: string;
  ownedByReader: boolean;
}

/** A process diagnostic as `deriveProcess` reports it; only its code and place are read. */
export interface ProcessIssue {
  code: string;
  nodeId?: string;
  edge?: string;
}

type Node = WorkflowGraph["nodes"][number] & {
  connections?: Record<string, string>;
  progressNodeId?: string;
  directive?: unknown;
  completionCondition?: unknown;
};

const nodesOf = (graph: WorkflowGraph) => graph.nodes as Node[];
const blockIds = (graph: WorkflowGraph) => (graph.progress?.nodes ?? []).map((block) => block.id);
const result = (findings: LessonFinding[]): LessonResult => ({
  passed: findings.length === 0,
  findings,
});
const sameMap = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
const filled = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** Lesson 1: the person's own private copy, with the example's structure and a process view. */
export function checkOwnCopy(
  copy: WorkflowGraph,
  example: WorkflowGraph,
  facts: CopyFacts,
): LessonResult {
  const findings: LessonFinding[] = [];
  if (!facts.ownedByReader) findings.push({ code: "copy-not-owned" });
  if (facts.visibility !== "private") findings.push({ code: "copy-not-private" });
  if (!copy.progress) findings.push({ code: "copy-no-process" });
  const byId = new Map(nodesOf(copy).map((node) => [node.id, node]));
  const differs =
    byId.size !== example.nodes.length ||
    nodesOf(example).some((node) => {
      const own = byId.get(node.id);
      return (
        !own ||
        own.type !== node.type ||
        own.progressNodeId !== node.progressNodeId ||
        !sameMap(own.connections, node.connections)
      );
    }) ||
    blockIds(copy).join(",") !== blockIds(example).join(",");
  if (differs) findings.push({ code: "copy-structure-differs" });
  return result(findings);
}

/** The agent steps the example does not have: the steps a lesson added. */
function addedSteps(draft: WorkflowGraph, example: WorkflowGraph): Node[] {
  const known = new Set(example.nodes.map((node) => node.id));
  return nodesOf(draft).filter((node) => node.type === "agent-directive" && !known.has(node.id));
}

/** Lesson 2: exactly one new agent step, with its directive and completion condition, in a block. */
export function checkNewStep(draft: WorkflowGraph, example: WorkflowGraph): LessonResult {
  const findings: LessonFinding[] = [];
  const ids = new Set(draft.nodes.map((node) => node.id));
  for (const node of example.nodes) {
    if (!ids.has(node.id)) findings.push({ code: "example-step-missing", nodeId: node.id });
  }
  const added = addedSteps(draft, example);
  if (added.length === 0) return result([...findings, { code: "new-step-missing" }]);
  if (added.length > 1) {
    return result([...findings, { code: "new-step-extra", data: { count: added.length } }]);
  }
  const step = added[0];
  if (!filled(step.directive)) {
    findings.push({ code: "new-step-directive-empty", nodeId: step.id, field: "directive" });
  }
  if (!filled(step.completionCondition)) {
    findings.push({
      code: "new-step-condition-empty",
      nodeId: step.id,
      field: "completionCondition",
    });
  }
  if (!step.progressNodeId || !blockIds(draft).includes(step.progressNodeId)) {
    findings.push({ code: "new-step-no-block", nodeId: step.id });
  }
  return result(findings);
}

/** The nodes reachable from the start along any connection. */
function reachable(nodes: Node[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = nodes.find((node) => node.type === "start");
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    queue.push(...Object.values(byId.get(id)!.connections ?? {}));
  }
  return seen;
}

/** The nodes from which some route reaches an end node. */
function reachingEnd(nodes: Node[]): Set<string> {
  const reaching = new Set(nodes.filter((node) => node.type === "end").map((node) => node.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      if (reaching.has(node.id)) continue;
      if (Object.values(node.connections ?? {}).some((target) => reaching.has(target))) {
        reaching.add(node.id);
        changed = true;
      }
    }
  }
  return reaching;
}

/**
 * Lesson 3: the new step sits between `do-task` and `check-result`, every node is reachable and
 * reaches an end, no connection dangles, and the process reports nothing — the label a connection
 * into another block needs included.
 */
export function checkConnected(
  draft: WorkflowGraph,
  example: WorkflowGraph,
  processIssues: readonly ProcessIssue[],
): LessonResult {
  const added = addedSteps(draft, example);
  if (added.length !== 1) return checkNewStep(draft, example);
  const step = added[0];
  const nodes = nodesOf(draft);
  const findings: LessonFinding[] = [];
  const doTask = nodes.find((node) => node.id === "do-task");
  if (doTask?.connections?.success !== step.id) {
    findings.push({
      code: "new-step-not-connected",
      nodeId: "do-task",
      field: "success",
      data: { step: step.id },
    });
  }
  if (step.connections?.success !== "check-result") {
    findings.push({ code: "new-step-not-continuing", nodeId: step.id, field: "success" });
  }
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const [key, target] of Object.entries(node.connections ?? {})) {
      if (!ids.has(target)) {
        findings.push({ code: "dangling-connection", nodeId: node.id, field: key });
      }
    }
  }
  const seen = reachable(nodes);
  const ending = reachingEnd(nodes);
  for (const node of nodes) {
    if (!seen.has(node.id)) findings.push({ code: "unreachable-node", nodeId: node.id });
    else if (!ending.has(node.id)) findings.push({ code: "route-without-end", nodeId: node.id });
  }
  for (const issue of processIssues) {
    const nodeId = issue.nodeId ?? issue.edge?.split(".")[0];
    findings.push(
      issue.code === "unlabeled-edge"
        ? { code: "edge-needs-label", nodeId, field: issue.edge?.split(".")[1] }
        : { code: "process-issue", nodeId, data: { issue: issue.code } },
    );
  }
  return result(findings);
}

/** Every finding code the checks can return; each has copy in both locales. */
export const TUTORIAL_FINDING_CODES = [
  "copy-not-owned",
  "copy-not-private",
  "copy-no-process",
  "copy-structure-differs",
  "example-step-missing",
  "new-step-missing",
  "new-step-extra",
  "new-step-directive-empty",
  "new-step-condition-empty",
  "new-step-no-block",
  "new-step-not-connected",
  "new-step-not-continuing",
  "dangling-connection",
  "unreachable-node",
  "route-without-end",
  "edge-needs-label",
  "process-issue",
] as const;

/** The lessons whose result is checked on a definition, in order. */
export const TUTORIAL_CHECKED_LESSONS = ["lesson-1", "lesson-2", "lesson-3"] as const;
