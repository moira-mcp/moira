/** Plan and atomically apply the bundled workflow catalog. */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { CatalogEntry } from "./workflow-catalog.js";
import { ownerSlugKey } from "./workflow-catalog.js";
import { compareSemver, isValidSemver } from "../utils/version-utils.js";
import {
  reconcileManagedResource,
  type ReconciliationClassification,
} from "./managed-resource-reconciler.js";
import {
  WorkflowReconciliationRepository,
  WorkflowReconciliationStaleError,
  getWorkflowReconciliationStatusSummary,
  managedWorkflowStatesEqual,
  managedWorkflowStateDigest,
  canonicalizeManagedWorkflowValue,
  workflowReconciliationConflictRevision,
  parseManagedWorkflowState,
  type ManagedWorkflowBaselineRecord,
  type ManagedWorkflowState,
  type WorkflowReconciliationConflictRecord,
  type WorkflowReconciliationApplyPlan,
  type WorkflowReconciliationSelection,
} from "../database/repositories/workflow-reconciliation-repository.js";
import { getSqliteInstance } from "../database/connection.js";
import { MAX_WORKFLOW_SIZE_BYTES } from "../database/repositories/workflow-repository.js";
import { validateSlug } from "../validation/slug-handle.js";

export class CatalogReconciliationError extends Error {
  constructor(
    public readonly conflicts: Array<{
      owner: string;
      slug: string;
      classification: string;
    }>,
  ) {
    super(
      `Bundled workflow reconciliation requires attention for: ${conflicts
        .map((conflict) => `${conflict.owner}/${conflict.slug} (${conflict.classification})`)
        .join(", ")}`,
    );
    this.name = "CatalogReconciliationError";
  }
}

export class CatalogPreflightError extends Error {
  constructor(public readonly result: CatalogLoadResult) {
    super(
      `Bundled workflow catalog preflight found ${result.invalid} invalid entr${result.invalid === 1 ? "y" : "ies"}`,
    );
    this.name = "CatalogPreflightError";
  }
}

export type EntryOutcome =
  | "installed"
  | "updated"
  | "removed"
  | "adopted"
  | "preserved-user-change"
  | "skipped-unchanged"
  | "skipped-older"
  | "skipped-missing-owner"
  | "conflict"
  | "invalid-workflow"
  | "invalid-version";

export interface CatalogLoadResult {
  installed: number;
  updated: number;
  removed: number;
  adopted: number;
  preserved: number;
  conflicts: number;
  skipped: number;
  skippedMissingOwner: number;
  invalid: number;
  outcomes: Array<{
    owner: string;
    slug: string;
    outcome: EntryOutcome;
    classification?: ReconciliationClassification;
  }>;
}

export interface CatalogUserRepo {
  getProfile(userId: string): Promise<unknown | null>;
}

export interface CatalogMutationService {
  validate(graph: WorkflowGraph): Promise<{
    status: "valid" | "invalid" | "unknown";
    errors: string[];
  }>;
}

export interface CatalogLoadDeps {
  userRepo: CatalogUserRepo;
  mutationService: CatalogMutationService;
  sqlite?: Database.Database;
  force?: boolean;
  fatalConflicts?: boolean;
  /** Internal compatibility switch; complete startup reconciliation keeps this true. */
  reconcileRemovals?: boolean;
  log?: (message: string) => void;
}

interface PlannedIdentity {
  owner: string;
  slug: string;
  previousSlug?: string;
  entry: CatalogEntry | null;
  baseline: ManagedWorkflowBaselineRecord | null;
}

function emptyResult(): CatalogLoadResult {
  return {
    installed: 0,
    updated: 0,
    removed: 0,
    adopted: 0,
    preserved: 0,
    conflicts: 0,
    skipped: 0,
    skippedMissingOwner: 0,
    invalid: 0,
    outcomes: [],
  };
}

function workflowStatesEqual(left: ManagedWorkflowState, right: ManagedWorkflowState): boolean {
  return managedWorkflowStatesEqual(left, right);
}

function incomingState(entry: CatalogEntry): ManagedWorkflowState {
  return {
    lifecycle: "present",
    content: { graph: entry.graph, visibility: entry.visibility },
  };
}

function versionOf(state: ManagedWorkflowState | null): string | null {
  if (!state || state.lifecycle === "absent") return null;
  const metadata = state.content.graph.metadata as { version?: unknown } | undefined;
  return typeof metadata?.version === "string" ? metadata.version : null;
}

function removalState(previous: ManagedWorkflowState): ManagedWorkflowState {
  if (previous.lifecycle === "absent") return previous;
  return { lifecycle: "deleted", content: previous.content };
}

function conflictInstruction(owner: string, slug: string): string {
  const base = `database:workflow-reconciliation:${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
  return (
    `Run Workflow Management Flow (WMF) for ${owner}/${slug}. Semantically merge the full ` +
    `previous managed, current user, and incoming bundled candidates at ${base}#previous, ` +
    `${base}#current, and ${base}#incoming. Preserve intentional user edits. Save the selected or ` +
    `merged lifecycle and graph, then explicitly acknowledge the resolution: ` +
    `use the MCP reconciliation tool for ${owner}/${slug} with the merged graph, ` +
    `or run migrate-workflows-in-docker.ts --resolve ${owner}/${slug}:current.`
  );
}

function buildIdentities(
  entries: CatalogEntry[],
  baselines: ManagedWorkflowBaselineRecord[],
  reconcileRemovals: boolean,
): PlannedIdentity[] {
  const baselineMap = new Map(baselines.map((item) => [ownerSlugKey(item.owner, item.slug), item]));
  const claimed = new Set<string>();
  const identities: PlannedIdentity[] = [];
  const incomingKeys = new Set<string>();
  const claimedAliases = new Map<string, string>();

  for (const entry of entries) {
    const key = ownerSlugKey(entry.owner, entry.slug);
    if (incomingKeys.has(key))
      throw new Error(`Duplicate catalog identity ${entry.owner}/${entry.slug}`);
    incomingKeys.add(key);
    for (const alias of [entry.slug, ...(entry.previousSlugs ?? [])]) {
      const aliasKey = ownerSlugKey(entry.owner, alias);
      const existingTarget = claimedAliases.get(aliasKey);
      if (existingTarget && existingTarget !== key) {
        throw new Error(
          `Duplicate catalog legacy identity ${entry.owner}/${alias} is claimed by ${existingTarget} and ${key}`,
        );
      }
      claimedAliases.set(aliasKey, key);
    }
    const candidates = [entry.slug, ...(entry.previousSlugs ?? [])]
      .map((slug) => ({ slug, baseline: baselineMap.get(ownerSlugKey(entry.owner, slug)) }))
      .filter(
        (candidate): candidate is { slug: string; baseline: ManagedWorkflowBaselineRecord } =>
          candidate.baseline !== undefined,
      );
    if (candidates.length > 1) {
      throw new Error(
        `${entry.owner}/${entry.slug} matches more than one previous managed identity: ${candidates
          .map((candidate) => candidate.slug)
          .join(", ")}`,
      );
    }
    const match = candidates[0];
    if (match) claimed.add(ownerSlugKey(entry.owner, match.slug));
    identities.push({
      owner: entry.owner,
      slug: entry.slug,
      previousSlug: match && match.slug !== entry.slug ? match.slug : undefined,
      entry,
      baseline: match?.baseline ?? null,
    });
  }

  for (const baseline of reconcileRemovals ? baselines : []) {
    const key = ownerSlugKey(baseline.owner, baseline.slug);
    if (!claimed.has(key) && !incomingKeys.has(key)) {
      identities.push({
        owner: baseline.owner,
        slug: baseline.slug,
        entry: null,
        baseline,
      });
    }
  }
  return identities;
}

function outcomeFor(
  classification: ReconciliationClassification,
  incoming: ManagedWorkflowState,
): EntryOutcome {
  if (classification === "first-install") return "installed";
  if (classification === "first-adoption") return "adopted";
  if (classification === "user-only") return "preserved-user-change";
  if (classification === "unchanged") return "skipped-unchanged";
  if (classification === "baseline-missing" || classification === "conflict") return "conflict";
  if (incoming.lifecycle === "deleted") return "removed";
  return "updated";
}

function addOutcome(
  result: CatalogLoadResult,
  owner: string,
  slug: string,
  outcome: EntryOutcome,
  classification?: ReconciliationClassification,
): void {
  result.outcomes.push({ owner, slug, outcome, classification });
  if (outcome === "installed") result.installed++;
  else if (outcome === "updated") result.updated++;
  else if (outcome === "removed") result.removed++;
  else if (outcome === "adopted") result.adopted++;
  else if (outcome === "preserved-user-change") result.preserved++;
  else if (outcome === "conflict") result.conflicts++;
  else if (outcome === "skipped-missing-owner") result.skippedMissingOwner++;
  else if (outcome === "invalid-version" || outcome === "invalid-workflow") result.invalid++;
  else result.skipped++;
}

export interface CatalogApplyPlanResult {
  result: CatalogLoadResult;
  applyPlan: WorkflowReconciliationApplyPlan;
}

export async function planCatalogEntries(
  entries: CatalogEntry[],
  deps: CatalogLoadDeps,
): Promise<CatalogApplyPlanResult> {
  const sqlite = deps.sqlite ?? getSqliteInstance();
  const repository = new WorkflowReconciliationRepository(sqlite);
  const baselines = repository.listBaselines();
  const identities = buildIdentities(entries, baselines, deps.reconcileRemovals !== false);
  const result = emptyResult();
  const applyPlan: WorkflowReconciliationApplyPlan = {
    preconditions: [],
    conflictPreconditions: [],
    baselinePreconditions: [],
    workflows: [],
    baselines: [],
    conflicts: [],
    clearConflicts: [],
  };
  const ownerExists = new Map<string, boolean>();

  // Complete preflight: all reads and graph validation happen before repository.apply().
  for (const identity of identities) {
    let exists = ownerExists.get(identity.owner);
    if (exists === undefined) {
      exists = (await deps.userRepo.getProfile(identity.owner)) !== null;
      ownerExists.set(identity.owner, exists);
    }
    if (!exists) {
      addOutcome(result, identity.owner, identity.slug, "skipped-missing-owner");
      continue;
    }

    const invalidSlug = [identity.slug, ...(identity.entry?.previousSlugs ?? [])].find(
      (slug) => !validateSlug(slug).valid,
    );
    if (invalidSlug) {
      addOutcome(result, identity.owner, identity.slug, "invalid-workflow");
      continue;
    }

    const localVersion = identity.entry ? versionOf(incomingState(identity.entry)) : null;
    if (identity.entry && (!localVersion || !isValidSemver(localVersion))) {
      addOutcome(result, identity.owner, identity.slug, "invalid-version");
      continue;
    }

    let incomingValidation: { isValid: boolean; errors: string[] } | undefined;
    if (identity.entry) {
      if (
        Buffer.byteLength(JSON.stringify(identity.entry.graph), "utf8") > MAX_WORKFLOW_SIZE_BYTES
      ) {
        addOutcome(result, identity.owner, identity.slug, "invalid-workflow");
        continue;
      }
      const checked = await deps.mutationService.validate(
        identity.entry.graph as unknown as WorkflowGraph,
      );
      incomingValidation = { isValid: checked.status === "valid", errors: checked.errors };
      if (!incomingValidation.isValid) {
        addOutcome(result, identity.owner, identity.slug, "invalid-workflow");
        continue;
      }
    }

    const lookupSlugs = [identity.slug, ...(identity.entry?.previousSlugs ?? [])];
    const currentRow = repository.findWorkflow(identity.owner, lookupSlugs);
    const current: ManagedWorkflowState = currentRow
      ? {
          lifecycle: currentRow.deleted ? "deleted" : "present",
          content: { graph: currentRow.graph, visibility: currentRow.visibility },
        }
      : { lifecycle: "absent" };
    const incoming = identity.entry
      ? incomingState(identity.entry)
      : removalState(identity.baseline!.state);

    const previousVersion =
      identity.baseline?.sourceVersion ?? versionOf(identity.baseline?.state ?? null);
    if (
      !deps.force &&
      localVersion &&
      previousVersion &&
      isValidSemver(previousVersion) &&
      compareSemver(localVersion, previousVersion) < 0
    ) {
      addOutcome(result, identity.owner, identity.slug, "skipped-older");
      continue;
    }

    applyPlan.preconditions.push({
      owner: identity.owner,
      slug: identity.slug,
      lookupSlugs,
      workflowId: currentRow?.id,
      expected: current,
    });
    applyPlan.baselinePreconditions.push({
      owner: identity.owner,
      slug: identity.slug,
      lookupSlugs,
      expected: identity.baseline,
    });

    const sameVersionSourceMismatch =
      !deps.force &&
      identity.baseline !== null &&
      localVersion !== null &&
      previousVersion === localVersion &&
      !workflowStatesEqual(identity.baseline.state, incoming);
    const decision = sameVersionSourceMismatch
      ? {
          classification: "conflict" as const,
          previous: identity.baseline!.state,
          current,
          incoming,
          selected: null,
          advanceBaseline: false,
          unresolved: true,
        }
      : deps.force
        ? {
            classification: (identity.baseline
              ? "upstream-only"
              : "first-install") as ReconciliationClassification,
            previous: identity.baseline?.state ?? null,
            current,
            incoming,
            selected: "incoming" as const,
            advanceBaseline: true,
            unresolved: false,
          }
        : reconcileManagedResource(
            identity.baseline?.state ?? null,
            current,
            incoming,
            workflowStatesEqual,
          );
    const outcome = outcomeFor(decision.classification, incoming);
    addOutcome(result, identity.owner, identity.slug, outcome, decision.classification);

    if (decision.unresolved) {
      applyPlan.conflicts.push({
        owner: identity.owner,
        slug: identity.slug,
        previousSlug: identity.previousSlug,
        currentWorkflowId: currentRow?.id,
        currentWorkflowSlug: currentRow?.slug,
        classification: decision.classification,
        previous: decision.previous,
        current,
        incoming,
        instruction: conflictInstruction(identity.owner, identity.slug),
      });
      continue;
    }

    applyPlan.clearConflicts.push({
      owner: identity.owner,
      slug: identity.slug,
      previousSlug: identity.previousSlug,
    });
    if (decision.selected === "incoming" && !workflowStatesEqual(current, incoming)) {
      applyPlan.workflows.push({
        owner: identity.owner,
        slug: identity.slug,
        workflowId: currentRow?.id,
        state: incoming,
        validation: incomingValidation,
      });
    }
    if (decision.advanceBaseline) {
      applyPlan.baselines.push({
        owner: identity.owner,
        slug: identity.slug,
        previousSlug: identity.previousSlug,
        state: incoming,
        sourceVersion: versionOf(incoming),
      });
    }
  }

  if (result.invalid > 0) {
    throw new CatalogPreflightError(result);
  }
  return { result, applyPlan };
}

export async function installCatalogEntries(
  entries: CatalogEntry[],
  deps: CatalogLoadDeps,
): Promise<CatalogLoadResult> {
  const sqlite = deps.sqlite ?? getSqliteInstance();
  const repository = new WorkflowReconciliationRepository(sqlite);
  const { result, applyPlan } = await planCatalogEntries(entries, deps);
  if (result.conflicts > 0 && !deps.force) {
    // Persist complete conflict evidence, but do not partially advance any
    // workflow or baseline while the catalog as a whole is unresolved.
    repository.apply({
      preconditions: applyPlan.preconditions,
      conflictPreconditions: [],
      baselinePreconditions: applyPlan.baselinePreconditions,
      workflows: [],
      baselines: [],
      conflicts: applyPlan.conflicts,
      clearConflicts: [],
    });
  } else {
    repository.apply(applyPlan);
  }
  for (const outcome of result.outcomes) {
    deps.log?.(`  ${outcome.owner}/${outcome.slug}: ${outcome.outcome}`);
  }
  if (deps.fatalConflicts && result.conflicts > 0) {
    throw new CatalogReconciliationError(
      result.outcomes
        .filter((item) => item.outcome === "conflict")
        .map((item) => ({
          owner: item.owner,
          slug: item.slug,
          classification: item.classification ?? "conflict",
        })),
    );
  }
  return result;
}

export async function installCatalogEntry(
  entry: CatalogEntry,
  deps: CatalogLoadDeps,
): Promise<EntryOutcome> {
  const result = await installCatalogEntries([entry], { ...deps, reconcileRemovals: false });
  return result.outcomes[0]?.outcome ?? "skipped-unchanged";
}

export function formatWorkflowReconciliationNotice(sqlite: Database.Database): string | null {
  const conflicts = getWorkflowReconciliationStatusSummary(sqlite).conflicts;
  if (conflicts.length === 0) return null;
  return [
    "ERROR MANAGED_WORKFLOW_RECONCILIATION_REQUIRED: this instance is operable but degraded.",
    ...conflicts.map(
      (conflict) =>
        `${conflict.owner}/${conflict.slug} (${conflict.classification}); ` +
        `previous=${conflict.candidateRefs.previous ?? "absent"}; ` +
        `current=${conflict.candidateRefs.current}; incoming=${conflict.candidateRefs.incoming}; ` +
        `recovery=${conflict.recoveryLocation}. ${conflict.instruction}`,
    ),
  ].join("\n");
}

const MAX_RESOLUTION_RATIONALE_LENGTH = 2_000;
const MAX_RESIDUAL_DELTA_PATHS = 1_000;

function boundedResidualDelta(
  incoming: ManagedWorkflowState,
  result: ManagedWorkflowState,
): string[] {
  const paths: string[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (paths.length >= MAX_RESIDUAL_DELTA_PATHS) return;
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)
    ) {
      paths.push(path || "$");
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index++)
        visit(left[index], right[index], `${path}[${index}]`);
      return;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) visit(leftRecord[key], rightRecord[key], path ? `${path}.${key}` : key);
  };
  const canonicalState = (state: ManagedWorkflowState): unknown =>
    state.lifecycle === "absent"
      ? state
      : {
          lifecycle: state.lifecycle,
          content: {
            visibility: state.content.visibility,
            graph: canonicalizeManagedWorkflowValue(state.content.graph),
          },
        };
  visit(canonicalState(incoming), canonicalState(result), "$");
  if (paths.length >= MAX_RESIDUAL_DELTA_PATHS) return ["$ (delta exceeds bounded path detail)"];
  return paths;
}

export interface WorkflowReconciliationDecisionInput {
  reference: string;
  revision: string;
  selection: WorkflowReconciliationSelection;
  merged?: ManagedWorkflowState;
  rationale: string;
}

export interface WorkflowReconciliationStagedArtifact {
  version: 1;
  sourceIdentity: string;
  catalogDigest: string;
  conflictSetDigest: string;
  decisions: WorkflowReconciliationDecisionInput[];
  artifactDigest: string;
}

export function workflowReconciliationConflictSetDigest(
  conflicts: WorkflowReconciliationConflictRecord[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        conflicts
          .map((conflict) => `${conflict.owner}/${conflict.slug}:${conflict.revision}`)
          .sort(),
      ),
    )
    .digest("hex");
}

export function workflowReconciliationStagedArtifactDigest(artifact: unknown): string {
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}

function validateStagedArtifact(value: unknown): WorkflowReconciliationStagedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid staged reconciliation artifact schema");
  }
  const artifact = value as Record<string, unknown>;
  const keys = Object.keys(artifact).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(
      [
        "artifactDigest",
        "catalogDigest",
        "conflictSetDigest",
        "decisions",
        "sourceIdentity",
        "version",
      ].sort(),
    )
  ) {
    throw new Error("Invalid staged reconciliation artifact schema");
  }
  if (
    artifact.version !== 1 ||
    typeof artifact.sourceIdentity !== "string" ||
    artifact.sourceIdentity.trim().length === 0 ||
    typeof artifact.catalogDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.catalogDigest) ||
    typeof artifact.conflictSetDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.conflictSetDigest) ||
    typeof artifact.artifactDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.artifactDigest) ||
    !Array.isArray(artifact.decisions)
  ) {
    throw new Error("Invalid staged reconciliation artifact schema");
  }
  for (const rawDecision of artifact.decisions) {
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) {
      throw new Error("Invalid staged reconciliation decision schema");
    }
    const decision = rawDecision as Record<string, unknown>;
    if (
      Object.keys(decision).some(
        (key) => !["reference", "revision", "selection", "merged", "rationale"].includes(key),
      )
    ) {
      throw new Error("Invalid staged reconciliation decision schema");
    }
    if (
      typeof decision.reference !== "string" ||
      !/^[^/]+\/[^/]+$/.test(decision.reference) ||
      typeof decision.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(decision.revision) ||
      (decision.selection !== "current" &&
        decision.selection !== "incoming" &&
        decision.selection !== "previous") ||
      typeof decision.rationale !== "string" ||
      !decision.rationale.trim() ||
      decision.rationale.length > MAX_RESOLUTION_RATIONALE_LENGTH
    ) {
      throw new Error("Invalid staged reconciliation decision schema");
    }
    if (decision.merged !== undefined) {
      if (decision.selection !== "current") {
        throw new Error("Invalid staged reconciliation merged state schema");
      }
      parseManagedWorkflowState(decision.merged, "staged reconciliation merged state");
    }
  }
  return value as WorkflowReconciliationStagedArtifact;
}

export function workflowCatalogDigest(entries: CatalogEntry[]): string {
  const canonical = entries
    .map((entry) => ({
      owner: entry.owner,
      slug: entry.slug,
      previousSlugs: [...(entry.previousSlugs ?? [])].sort(),
      state: incomingState(entry),
    }))
    .sort((left, right) =>
      ownerSlugKey(left.owner, left.slug).localeCompare(ownerSlugKey(right.owner, right.slug)),
    );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createWorkflowReconciliationStagedArtifact(
  sqlite: Database.Database,
  sourceIdentity: string,
  entries: CatalogEntry[],
  decisions: WorkflowReconciliationDecisionInput[],
): WorkflowReconciliationStagedArtifact {
  if (!sourceIdentity.trim()) {
    throw new Error("sourceIdentity is required");
  }
  const conflicts = new WorkflowReconciliationRepository(sqlite).listConflicts();
  return createWorkflowReconciliationStagedArtifactFromConflicts(
    conflicts,
    sourceIdentity,
    entries,
    decisions,
  );
}

export function createWorkflowReconciliationStagedArtifactFromConflicts(
  conflicts: WorkflowReconciliationConflictRecord[],
  sourceIdentity: string,
  entries: CatalogEntry[],
  decisions: WorkflowReconciliationDecisionInput[],
): WorkflowReconciliationStagedArtifact {
  if (!sourceIdentity.trim()) {
    throw new Error("sourceIdentity is required");
  }
  const byReference = new Map(conflicts.map((item) => [`${item.owner}/${item.slug}`, item]));
  if (decisions.length !== conflicts.length) {
    throw new Error("A staged artifact must decide the complete current conflict set");
  }
  const seen = new Set<string>();
  for (const decision of decisions) {
    const conflict = byReference.get(decision.reference);
    if (!conflict || seen.has(decision.reference) || conflict.revision !== decision.revision) {
      const [owner = "unknown", slug = "unknown"] = decision.reference.split("/", 2);
      throw new WorkflowReconciliationStaleError(owner, slug);
    }
    if (!decision.rationale.trim() || decision.rationale.length > MAX_RESOLUTION_RATIONALE_LENGTH) {
      throw new Error("Resolution rationale must be non-empty and at most 2000 characters");
    }
    seen.add(decision.reference);
  }
  const body = {
    version: 1 as const,
    sourceIdentity,
    catalogDigest: workflowCatalogDigest(entries),
    conflictSetDigest: workflowReconciliationConflictSetDigest(conflicts),
    decisions,
  };
  return { ...body, artifactDigest: workflowReconciliationStagedArtifactDigest(body) };
}

export async function applyWorkflowReconciliationStagedArtifact(
  artifactInput: unknown,
  currentSourceIdentity: string,
  entries: CatalogEntry[],
  deps: CatalogLoadDeps,
  resolutionContext: { actorId?: string; source?: string } = {},
): Promise<void> {
  const artifact = validateStagedArtifact(artifactInput);
  const { artifactDigest, ...body } = artifact;
  if (
    artifact.version !== 1 ||
    workflowReconciliationStagedArtifactDigest(body) !== artifactDigest
  ) {
    throw new Error("Invalid staged reconciliation artifact digest");
  }
  if (
    artifact.sourceIdentity !== currentSourceIdentity ||
    artifact.catalogDigest !== workflowCatalogDigest(entries)
  ) {
    throw new Error("Staged reconciliation source or catalog identity changed");
  }
  const sqlite = deps.sqlite ?? getSqliteInstance();
  const repository = new WorkflowReconciliationRepository(sqlite);
  const planned = await planCatalogEntries(entries, {
    ...deps,
    force: false,
    fatalConflicts: false,
  });
  const conflicts: WorkflowReconciliationConflictRecord[] = planned.applyPlan.conflicts.map(
    (conflict) => ({
      owner: conflict.owner,
      slug: conflict.slug,
      currentWorkflowId: conflict.currentWorkflowId ?? null,
      currentWorkflowSlug: conflict.currentWorkflowSlug ?? null,
      previousManagedSlug: conflict.previousSlug ?? null,
      classification: conflict.classification,
      previous: conflict.previous,
      current: conflict.current,
      incoming: conflict.incoming,
      instruction: conflict.instruction,
      revision: workflowReconciliationConflictRevision({
        owner: conflict.owner,
        slug: conflict.slug,
        currentWorkflowId: conflict.currentWorkflowId,
        currentWorkflowSlug: conflict.currentWorkflowSlug,
        previousManagedSlug: conflict.previousSlug,
        classification: conflict.classification,
        previous: conflict.previous,
        current: conflict.current,
        incoming: conflict.incoming,
        instruction: conflict.instruction,
      }),
      candidateRefs: { previous: null, current: "", incoming: "" },
      recoveryLocation: "",
    }),
  );
  if (artifact.conflictSetDigest !== workflowReconciliationConflictSetDigest(conflicts)) {
    throw new Error("Staged reconciliation conflict set changed");
  }
  const byReference = new Map(conflicts.map((item) => [`${item.owner}/${item.slug}`, item]));
  if (artifact.decisions.length !== conflicts.length) {
    throw new Error("Staged reconciliation decisions do not cover the current conflict set");
  }

  const applyPlan: WorkflowReconciliationApplyPlan = {
    ...planned.applyPlan,
    conflicts: [],
    resolutionAudits: [],
    resolutions: [],
  };
  const seen = new Set<string>();
  for (const decision of artifact.decisions) {
    const conflict = byReference.get(decision.reference);
    if (!conflict || seen.has(decision.reference) || conflict.revision !== decision.revision) {
      const [owner = "unknown", slug = "unknown"] = decision.reference.split("/", 2);
      throw new WorkflowReconciliationStaleError(owner, slug);
    }
    seen.add(decision.reference);
    if (!decision.rationale.trim() || decision.rationale.length > MAX_RESOLUTION_RATIONALE_LENGTH) {
      throw new Error("Resolution rationale must be non-empty and at most 2000 characters");
    }
    if (decision.merged && decision.selection !== "current") {
      throw new Error("A merged staged decision requires selection=current");
    }
    const selected =
      decision.merged ??
      (decision.selection === "incoming"
        ? conflict.incoming
        : decision.selection === "previous"
          ? conflict.previous
          : conflict.current);
    if (!selected) throw new Error(`${decision.reference} has no previous candidate to select`);
    for (const state of [conflict.incoming, selected]) {
      if (state.lifecycle === "absent") continue;
      if (
        Buffer.byteLength(JSON.stringify(state.content.graph), "utf8") > MAX_WORKFLOW_SIZE_BYTES
      ) {
        throw new Error(
          `Resolved workflow ${decision.reference} exceeds the maximum workflow size`,
        );
      }
      const checked = await deps.mutationService.validate(
        state.content.graph as unknown as WorkflowGraph,
      );
      if (checked.status !== "valid") {
        throw new Error(
          `Resolved workflow ${decision.reference} is invalid: ${checked.errors.join("; ")}`,
        );
      }
    }
    const currentWorkflowId = conflict.currentWorkflowId ?? undefined;
    if (
      decision.selection !== "current" ||
      decision.merged !== undefined ||
      conflict.currentWorkflowSlug !== conflict.slug
    ) {
      applyPlan.workflows.push({
        owner: conflict.owner,
        slug: conflict.slug,
        workflowId: currentWorkflowId,
        state: selected,
      });
    }
    applyPlan.baselines.push({
      owner: conflict.owner,
      slug: conflict.slug,
      previousSlug: conflict.previousManagedSlug ?? undefined,
      state: conflict.incoming,
      sourceVersion: versionOf(conflict.incoming),
    });
    applyPlan.clearConflicts.push({
      owner: conflict.owner,
      slug: conflict.slug,
      previousSlug: conflict.previousManagedSlug ?? undefined,
    });
    applyPlan.resolutionAudits!.push({
      owner: conflict.owner,
      slug: conflict.slug,
      actorId: resolutionContext.actorId,
      source: resolutionContext.source ?? "staged",
      selection: decision.selection,
      merged: decision.merged !== undefined,
    });
    applyPlan.resolutions!.push({
      owner: conflict.owner,
      slug: conflict.slug,
      incomingDigest: managedWorkflowStateDigest(conflict.incoming),
      resultDigest: managedWorkflowStateDigest(selected),
      selection: decision.selection,
      merged: decision.merged !== undefined,
      rationale: decision.rationale.trim(),
      residualDelta: boundedResidualDelta(conflict.incoming, selected),
      actorId: resolutionContext.actorId ?? null,
      source: resolutionContext.source ?? "staged",
      createdAt: Date.now(),
    });
  }
  repository.apply(applyPlan);
}

export async function resolveWorkflowReconciliation(
  reference: string,
  selection: WorkflowReconciliationSelection,
  deps: Pick<CatalogLoadDeps, "sqlite" | "mutationService">,
  merged?: ManagedWorkflowState,
  resolutionContext: {
    actorId?: string;
    source?: string;
    expectedRevision: string;
    rationale: string;
  },
): Promise<void> {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error("Resolution reference must be owner/slug");
  }
  const owner = reference.slice(0, separator);
  const slug = reference.slice(separator + 1);
  if (!validateSlug(slug).valid) {
    throw new Error(`Invalid workflow slug in resolution reference: ${slug}`);
  }
  const sqlite = deps.sqlite ?? getSqliteInstance();
  const repository = new WorkflowReconciliationRepository(sqlite);
  const conflict = repository.findConflict(owner, slug);
  if (!conflict) throw new Error(`No unresolved workflow reconciliation for ${reference}`);
  if (
    !resolutionContext.expectedRevision ||
    conflict.revision !== resolutionContext.expectedRevision
  ) {
    throw new WorkflowReconciliationStaleError(owner, slug);
  }
  if (merged && selection !== "current") {
    throw new Error("A merged state requires selection=current");
  }

  const selected =
    merged ??
    (selection === "incoming"
      ? conflict.incoming
      : selection === "previous"
        ? conflict.previous
        : conflict.current);
  if (selection === "previous" && selected === null) {
    throw new Error(`${reference} has no previous candidate to select`);
  }
  const rationale = resolutionContext.rationale.trim();
  if (!rationale || rationale.length > MAX_RESOLUTION_RATIONALE_LENGTH) {
    throw new Error("Resolution rationale must be non-empty and at most 2000 characters");
  }

  const validateResolutionState = async (
    state: ManagedWorkflowState,
  ): Promise<{ isValid: boolean; errors: string[] } | undefined> => {
    if (state.lifecycle === "absent") return undefined;
    if (Buffer.byteLength(JSON.stringify(state.content.graph), "utf8") > MAX_WORKFLOW_SIZE_BYTES) {
      throw new Error(`Resolved workflow ${reference} exceeds the maximum workflow size`);
    }
    const checked = await deps.mutationService.validate(
      state.content.graph as unknown as WorkflowGraph,
    );
    const validation = { isValid: checked.status === "valid", errors: checked.errors };
    if (!validation.isValid) {
      throw new Error(`Resolved workflow ${reference} is invalid: ${validation.errors.join("; ")}`);
    }
    return validation;
  };

  // The incoming state becomes the durable baseline for every resolution, so
  // validate it even when the administrator elects to keep the current state.
  const incomingValidation = await validateResolutionState(conflict.incoming);

  const currentWorkflowId = conflict.currentWorkflowId ?? undefined;
  const lookupSlugs = [
    ...new Set([slug, conflict.currentWorkflowSlug, conflict.previousManagedSlug].filter(Boolean)),
  ] as string[];

  const workflows: WorkflowReconciliationApplyPlan["workflows"] = [];
  const mustWriteSelected =
    selected !== null &&
    (selection !== "current" || merged !== undefined || conflict.currentWorkflowSlug !== slug);
  if (selected && mustWriteSelected) {
    const validation =
      selected === conflict.incoming ? incomingValidation : await validateResolutionState(selected);
    workflows.push({
      owner,
      slug,
      workflowId: currentWorkflowId,
      state: selected,
      validation,
    });
  }

  // The baseline records the accepted upstream candidate. Selecting/merging the
  // current database graph therefore becomes an intentional user delta against
  // that source and survives an unchanged image on the next startup.
  repository.apply({
    preconditions: [
      {
        owner,
        slug,
        lookupSlugs,
        workflowId: currentWorkflowId,
        expected: conflict.current,
      },
    ],
    conflictPreconditions: [{ owner, slug, revision: conflict.revision }],
    baselinePreconditions: [],
    workflows,
    baselines: [
      {
        owner,
        slug,
        previousSlug: conflict.previousManagedSlug ?? undefined,
        state: conflict.incoming,
        sourceVersion: versionOf(conflict.incoming),
      },
    ],
    conflicts: [],
    clearConflicts: [{ owner, slug }],
    resolutionAudits: [
      {
        owner,
        slug,
        actorId: resolutionContext.actorId,
        source: resolutionContext.source ?? "system",
        selection,
        merged: merged !== undefined,
      },
    ],
    resolutions:
      selected === null
        ? []
        : [
            {
              owner,
              slug,
              incomingDigest: managedWorkflowStateDigest(conflict.incoming),
              resultDigest: managedWorkflowStateDigest(selected),
              selection,
              merged: merged !== undefined,
              rationale,
              residualDelta: boundedResidualDelta(conflict.incoming, selected),
              actorId: resolutionContext.actorId ?? null,
              source: resolutionContext.source ?? "system",
              createdAt: Date.now(),
            },
          ],
  });
}
