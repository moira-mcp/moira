import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ManagedResourceState } from "../../services/managed-resource-reconciler.js";
import { AuditAction } from "../../audit/actions.js";

export interface ManagedWorkflowContent {
  graph: Record<string, unknown>;
  visibility: "public" | "private";
}

export type ManagedWorkflowState = ManagedResourceState<ManagedWorkflowContent>;

export interface ManagedWorkflowBaselineRecord {
  owner: string;
  slug: string;
  state: ManagedWorkflowState;
  sourceVersion: string | null;
}

export interface WorkflowReconciliationConflictRecord {
  owner: string;
  slug: string;
  currentWorkflowId: string | null;
  currentWorkflowSlug: string | null;
  previousManagedSlug: string | null;
  classification: string;
  previous: ManagedWorkflowState | null;
  current: ManagedWorkflowState;
  incoming: ManagedWorkflowState;
  instruction: string;
  revision: string;
  candidateRefs: { previous: string | null; current: string; incoming: string };
  recoveryLocation: string;
}

export type WorkflowReconciliationSelection = "current" | "incoming" | "previous";

export interface WorkflowReconciliationResolutionRecord {
  owner: string;
  slug: string;
  incomingDigest: string;
  resultDigest: string;
  selection: WorkflowReconciliationSelection;
  merged: boolean;
  rationale: string;
  residualDelta: string[];
  actorId: string | null;
  source: string;
  createdAt: number;
}

export interface PersistedWorkflowRow {
  id: string;
  owner: string;
  slug: string;
  graph: Record<string, unknown>;
  visibility: "public" | "private";
  deleted: boolean;
}

export interface WorkflowApplyOperation {
  owner: string;
  slug: string;
  workflowId?: string;
  state: ManagedWorkflowState;
  validation?: { isValid: boolean; errors: string[] };
}

export interface WorkflowStatePrecondition {
  owner: string;
  slug: string;
  lookupSlugs: string[];
  workflowId?: string;
  expected: ManagedWorkflowState;
}

export interface WorkflowConflictPrecondition {
  owner: string;
  slug: string;
  revision: string;
}

export interface ManagedWorkflowBaselinePrecondition {
  owner: string;
  slug: string;
  lookupSlugs: string[];
  expected: ManagedWorkflowBaselineRecord | null;
}

export interface BaselineApplyOperation {
  owner: string;
  slug: string;
  previousSlug?: string;
  state: ManagedWorkflowState;
  sourceVersion: string | null;
}

export interface ConflictApplyOperation {
  owner: string;
  slug: string;
  previousSlug?: string;
  currentWorkflowId?: string;
  currentWorkflowSlug?: string;
  classification: string;
  previous: ManagedWorkflowState | null;
  current: ManagedWorkflowState;
  incoming: ManagedWorkflowState;
  instruction: string;
}

export interface WorkflowReconciliationApplyPlan {
  preconditions: WorkflowStatePrecondition[];
  conflictPreconditions: WorkflowConflictPrecondition[];
  baselinePreconditions: ManagedWorkflowBaselinePrecondition[];
  workflows: WorkflowApplyOperation[];
  baselines: BaselineApplyOperation[];
  conflicts: ConflictApplyOperation[];
  clearConflicts: Array<{ owner: string; slug: string; previousSlug?: string }>;
  resolutionAudits?: Array<{
    owner: string;
    slug: string;
    actorId?: string;
    source: string;
    selection: "current" | "incoming" | "previous";
    merged: boolean;
  }>;
  resolutions?: WorkflowReconciliationResolutionRecord[];
}

export const WORKFLOW_RECONCILIATION_STALE_ERROR_CODE = "MANAGED_WORKFLOW_RECONCILIATION_STALE";

export class WorkflowReconciliationStaleError extends Error {
  readonly code = WORKFLOW_RECONCILIATION_STALE_ERROR_CODE;

  constructor(
    public readonly owner: string,
    public readonly slug: string,
  ) {
    super(
      `${WORKFLOW_RECONCILIATION_STALE_ERROR_CODE}: ${owner}/${slug} changed after reconciliation evidence was captured; rerun catalog reconciliation before resolving it`,
    );
    this.name = "WorkflowReconciliationStaleError";
  }
}

const candidateRef = (owner: string, slug: string, candidate: string): string =>
  `database:workflow-reconciliation:${encodeURIComponent(owner)}/${encodeURIComponent(slug)}#${candidate}`;

const recoveryLocation = (owner: string, slug: string): string =>
  `database:workflow-reconciliation:${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;

export function parseManagedWorkflowState(value: unknown, context: string): ManagedWorkflowState {
  try {
    const parsed = (typeof value === "string" ? JSON.parse(value) : value) as ManagedWorkflowState;
    if (
      !parsed ||
      (parsed.lifecycle !== "absent" &&
        parsed.lifecycle !== "deleted" &&
        parsed.lifecycle !== "present") ||
      (parsed.lifecycle !== "absent" &&
        (!parsed.content ||
          parsed.content.graph === null ||
          Array.isArray(parsed.content.graph) ||
          typeof parsed.content.graph !== "object" ||
          (parsed.content.visibility !== "public" && parsed.content.visibility !== "private")))
    ) {
      throw new Error("invalid state shape");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Malformed ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function canonicalizeManagedWorkflowValue(value: unknown, depth = 0): unknown {
  if (Array.isArray(value))
    return value.map((item) => canonicalizeManagedWorkflowValue(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (
      depth === 0 &&
      ["id", "slug", "owner", "visibility", "previousSlugs", "createdAt", "updatedAt"].includes(key)
    ) {
      continue;
    }
    result[key] = canonicalizeManagedWorkflowValue(record[key], depth + 1);
  }
  return result;
}

/** Canonical exact identity used by equality, stale checks and staged artifacts. */
export function managedWorkflowStateDigest(state: ManagedWorkflowState): string {
  const canonical =
    state.lifecycle === "absent"
      ? state
      : {
          lifecycle: state.lifecycle,
          content: {
            visibility: state.content.visibility,
            graph: canonicalizeManagedWorkflowValue(state.content.graph),
          },
        };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function managedWorkflowStatesEqual(
  left: ManagedWorkflowState,
  right: ManagedWorkflowState,
): boolean {
  if (left.lifecycle !== right.lifecycle) return false;
  if (left.lifecycle === "absent" || right.lifecycle === "absent") return true;
  return (
    left.content.visibility === right.content.visibility &&
    JSON.stringify(canonicalizeManagedWorkflowValue(left.content.graph)) ===
      JSON.stringify(canonicalizeManagedWorkflowValue(right.content.graph))
  );
}

interface PersistedConflictRow {
  ownerId: string;
  slug: string;
  currentWorkflowId: string | null;
  currentWorkflowSlug: string | null;
  previousManagedSlug: string | null;
  classification: string;
  previousState: string | null;
  currentState: string;
  incomingState: string;
  instruction: string;
}

export function workflowReconciliationConflictRevision(input: {
  owner: string;
  slug: string;
  currentWorkflowId?: string | null;
  currentWorkflowSlug?: string | null;
  previousManagedSlug?: string | null;
  classification: string;
  previous: ManagedWorkflowState | null;
  current: ManagedWorkflowState;
  incoming: ManagedWorkflowState;
  instruction: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.owner,
        input.slug,
        input.currentWorkflowId ?? null,
        input.currentWorkflowSlug ?? null,
        input.previousManagedSlug ?? null,
        input.classification,
        input.previous,
        input.current,
        input.incoming,
        input.instruction,
      ]),
    )
    .digest("hex");
}

function toConflictRecord(row: PersistedConflictRow): WorkflowReconciliationConflictRecord {
  const previous =
    row.previousState === null
      ? null
      : parseManagedWorkflowState(
          row.previousState,
          `workflow reconciliation previous candidate ${row.ownerId}/${row.slug}`,
        );
  const current = parseManagedWorkflowState(
    row.currentState,
    `workflow reconciliation current candidate ${row.ownerId}/${row.slug}`,
  );
  const incoming = parseManagedWorkflowState(
    row.incomingState,
    `workflow reconciliation incoming candidate ${row.ownerId}/${row.slug}`,
  );
  return {
    owner: row.ownerId,
    slug: row.slug,
    currentWorkflowId: row.currentWorkflowId,
    currentWorkflowSlug: row.currentWorkflowSlug,
    previousManagedSlug: row.previousManagedSlug,
    classification: row.classification,
    previous,
    current,
    incoming,
    instruction: row.instruction,
    revision: workflowReconciliationConflictRevision({
      owner: row.ownerId,
      slug: row.slug,
      currentWorkflowId: row.currentWorkflowId,
      currentWorkflowSlug: row.currentWorkflowSlug,
      previousManagedSlug: row.previousManagedSlug,
      classification: row.classification,
      previous,
      current,
      incoming,
      instruction: row.instruction,
    }),
    candidateRefs: {
      previous: row.previousState === null ? null : candidateRef(row.ownerId, row.slug, "previous"),
      current: candidateRef(row.ownerId, row.slug, "current"),
      incoming: candidateRef(row.ownerId, row.slug, "incoming"),
    },
    recoveryLocation: recoveryLocation(row.ownerId, row.slug),
  };
}

/** Synchronous persistence boundary used by the catalog executor. */
export class WorkflowReconciliationRepository {
  constructor(private sqlite: Database.Database) {}

  listBaselines(): ManagedWorkflowBaselineRecord[] {
    const rows = this.sqlite
      .prepare("SELECT ownerId, slug, state, sourceVersion FROM managedWorkflowBaseline")
      .all() as Array<{
      ownerId: string;
      slug: string;
      state: string;
      sourceVersion: string | null;
    }>;
    return rows.map((row) => ({
      owner: row.ownerId,
      slug: row.slug,
      state: parseManagedWorkflowState(
        row.state,
        `managed workflow baseline ${row.ownerId}/${row.slug}`,
      ),
      sourceVersion: row.sourceVersion,
    }));
  }

  findWorkflow(owner: string, slugs: string[]): PersistedWorkflowRow | null {
    if (slugs.length === 0) return null;
    const placeholders = slugs.map(() => "?").join(", ");
    const rows = this.sqlite
      .prepare(
        `SELECT id, userId, slug, graph, visibility, deleted
         FROM workflow WHERE userId = ? AND slug IN (${placeholders})`,
      )
      .all(owner, ...slugs) as Array<{
      id: string;
      userId: string;
      slug: string;
      graph: string;
      visibility: string;
      deleted: number;
    }>;
    if (rows.length > 1) {
      throw new Error(
        `${owner}/${slugs[0]} matches more than one current catalog identity: ${rows
          .map((row) => row.slug)
          .join(", ")}`,
      );
    }
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      owner: row.userId,
      slug: row.slug,
      graph: JSON.parse(row.graph) as Record<string, unknown>,
      visibility: row.visibility === "public" ? "public" : "private",
      deleted: Boolean(row.deleted),
    };
  }

  listConflicts(): WorkflowReconciliationConflictRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT ownerId, slug, currentWorkflowId, currentWorkflowSlug, previousManagedSlug, classification,
                previousState, currentState, incomingState, instruction
         FROM workflowReconciliationConflict ORDER BY ownerId, slug`,
      )
      .all() as PersistedConflictRow[];
    return rows.map(toConflictRecord);
  }

  findConflict(owner: string, slug: string): WorkflowReconciliationConflictRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT ownerId, slug, currentWorkflowId, currentWorkflowSlug, previousManagedSlug, classification,
                previousState, currentState, incomingState, instruction
         FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?`,
      )
      .get(owner, slug) as PersistedConflictRow | undefined;
    return row ? toConflictRecord(row) : null;
  }

  findResolution(owner: string, slug: string): WorkflowReconciliationResolutionRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT ownerId, slug, incomingDigest, resultDigest, selection, merged, rationale,
                residualDelta, actorId, source, createdAt
         FROM workflowReconciliationResolution WHERE ownerId = ? AND slug = ?`,
      )
      .get(owner, slug) as
      | {
          ownerId: string;
          slug: string;
          incomingDigest: string;
          resultDigest: string;
          selection: WorkflowReconciliationSelection;
          merged: number;
          rationale: string;
          residualDelta: string;
          actorId: string | null;
          source: string;
          createdAt: number;
        }
      | undefined;
    if (!row) return null;
    return {
      owner: row.ownerId,
      slug: row.slug,
      incomingDigest: row.incomingDigest,
      resultDigest: row.resultDigest,
      selection: row.selection,
      merged: Boolean(row.merged),
      rationale: row.rationale,
      residualDelta: JSON.parse(row.residualDelta) as string[],
      actorId: row.actorId,
      source: row.source,
      createdAt: row.createdAt,
    };
  }

  listConflictSummaries(): WorkflowReconciliationConflictSummary[] {
    const rows = this.sqlite
      .prepare(
        `SELECT ownerId, slug, classification, previousState IS NOT NULL AS hasPrevious, instruction
         FROM workflowReconciliationConflict ORDER BY ownerId, slug`,
      )
      .all() as Array<{
      ownerId: string;
      slug: string;
      classification: string;
      hasPrevious: number;
      instruction: string;
    }>;
    return rows.map((row) => ({
      owner: row.ownerId,
      slug: row.slug,
      classification: row.classification,
      instruction: row.instruction,
      candidateRefs: {
        previous: row.hasPrevious ? candidateRef(row.ownerId, row.slug, "previous") : null,
        current: candidateRef(row.ownerId, row.slug, "current"),
        incoming: candidateRef(row.ownerId, row.slug, "incoming"),
      },
      recoveryLocation: recoveryLocation(row.ownerId, row.slug),
    }));
  }

  apply(plan: WorkflowReconciliationApplyPlan): void {
    const applyTransaction = this.sqlite.transaction(() => {
      this.assertConflictPreconditions(plan.conflictPreconditions);
      this.assertBaselinePreconditions(plan.baselinePreconditions);
      this.assertPreconditions(plan.preconditions);
      const now = Date.now();
      for (const operation of plan.workflows) this.applyWorkflow(operation, now);
      for (const baseline of plan.baselines) {
        if (baseline.previousSlug && baseline.previousSlug !== baseline.slug) {
          this.sqlite
            .prepare("DELETE FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
            .run(baseline.owner, baseline.previousSlug);
        }
        this.sqlite
          .prepare(
            `INSERT INTO managedWorkflowBaseline (ownerId, slug, state, sourceVersion, updatedAt)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(ownerId, slug) DO UPDATE SET
               state = excluded.state,
               sourceVersion = excluded.sourceVersion,
               updatedAt = excluded.updatedAt`,
          )
          .run(
            baseline.owner,
            baseline.slug,
            JSON.stringify(baseline.state),
            baseline.sourceVersion,
            now,
          );
      }
      for (const target of plan.clearConflicts) {
        this.sqlite
          .prepare("DELETE FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?")
          .run(target.owner, target.slug);
        if (target.previousSlug && target.previousSlug !== target.slug) {
          this.sqlite
            .prepare("DELETE FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?")
            .run(target.owner, target.previousSlug);
        }
      }
      for (const conflict of plan.conflicts) {
        if (conflict.previousSlug && conflict.previousSlug !== conflict.slug) {
          this.sqlite
            .prepare("DELETE FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?")
            .run(conflict.owner, conflict.previousSlug);
        }
        this.sqlite
          .prepare(
            `INSERT INTO workflowReconciliationConflict
              (ownerId, slug, currentWorkflowId, currentWorkflowSlug, previousManagedSlug,
               classification, previousState, currentState, incomingState, instruction, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(ownerId, slug) DO UPDATE SET
               currentWorkflowId = excluded.currentWorkflowId,
               currentWorkflowSlug = excluded.currentWorkflowSlug,
               previousManagedSlug = excluded.previousManagedSlug,
               classification = excluded.classification,
               previousState = excluded.previousState,
               currentState = excluded.currentState,
               incomingState = excluded.incomingState,
               instruction = excluded.instruction,
               updatedAt = excluded.updatedAt`,
          )
          .run(
            conflict.owner,
            conflict.slug,
            conflict.currentWorkflowId ?? null,
            conflict.currentWorkflowSlug ?? null,
            conflict.previousSlug ?? null,
            conflict.classification,
            conflict.previous === null ? null : JSON.stringify(conflict.previous),
            JSON.stringify(conflict.current),
            JSON.stringify(conflict.incoming),
            conflict.instruction,
            now,
            now,
          );
      }
      for (const resolution of plan.resolutionAudits ?? []) {
        this.sqlite
          .prepare(
            `INSERT INTO auditLog
              (id, userId, action, resource, resourceId, source, metadata, createdAt)
             VALUES (?, ?, ?, 'workflow-reconciliation', ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            resolution.actorId ?? null,
            AuditAction.WORKFLOW_RECONCILIATION_RESOLVE,
            `${resolution.owner}/${resolution.slug}`,
            resolution.source,
            JSON.stringify({ selection: resolution.selection, merged: resolution.merged }),
            now,
          );
      }
      for (const resolution of plan.resolutions ?? []) {
        this.sqlite
          .prepare(
            `INSERT INTO workflowReconciliationResolution
              (ownerId, slug, incomingDigest, resultDigest, selection, merged, rationale,
               residualDelta, actorId, source, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(ownerId, slug) DO UPDATE SET
               incomingDigest = excluded.incomingDigest,
               resultDigest = excluded.resultDigest,
               selection = excluded.selection,
               merged = excluded.merged,
               rationale = excluded.rationale,
               residualDelta = excluded.residualDelta,
               actorId = excluded.actorId,
               source = excluded.source,
               createdAt = excluded.createdAt`,
          )
          .run(
            resolution.owner,
            resolution.slug,
            resolution.incomingDigest,
            resolution.resultDigest,
            resolution.selection,
            resolution.merged ? 1 : 0,
            resolution.rationale,
            JSON.stringify(resolution.residualDelta),
            resolution.actorId,
            resolution.source,
            resolution.createdAt,
          );
      }
    });
    applyTransaction();
  }

  private assertConflictPreconditions(preconditions: WorkflowConflictPrecondition[]): void {
    for (const precondition of preconditions) {
      const row = this.sqlite
        .prepare(
          `SELECT ownerId, slug, currentWorkflowId, currentWorkflowSlug, previousManagedSlug, classification,
                  previousState, currentState, incomingState, instruction
           FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?`,
        )
        .get(precondition.owner, precondition.slug) as PersistedConflictRow | undefined;
      if (!row || toConflictRecord(row).revision !== precondition.revision) {
        throw new WorkflowReconciliationStaleError(precondition.owner, precondition.slug);
      }
    }
  }

  private assertBaselinePreconditions(preconditions: ManagedWorkflowBaselinePrecondition[]): void {
    for (const precondition of preconditions) {
      const placeholders = precondition.lookupSlugs.map(() => "?").join(", ");
      const rows = this.sqlite
        .prepare(
          `SELECT ownerId, slug, state, sourceVersion
           FROM managedWorkflowBaseline WHERE ownerId = ? AND slug IN (${placeholders})`,
        )
        .all(precondition.owner, ...precondition.lookupSlugs) as Array<{
        ownerId: string;
        slug: string;
        state: string;
        sourceVersion: string | null;
      }>;
      const row = rows.length === 1 ? rows[0] : undefined;
      let matches = precondition.expected === null ? rows.length === 0 : row !== undefined;
      if (matches && row && precondition.expected) {
        try {
          matches =
            row.slug === precondition.expected.slug &&
            row.sourceVersion === precondition.expected.sourceVersion &&
            managedWorkflowStatesEqual(
              parseManagedWorkflowState(
                row.state,
                `managed workflow baseline precondition ${precondition.owner}/${precondition.slug}`,
              ),
              precondition.expected.state,
            );
        } catch {
          matches = false;
        }
      }
      if (!matches) {
        throw new WorkflowReconciliationStaleError(precondition.owner, precondition.slug);
      }
    }
  }

  private assertPreconditions(preconditions: WorkflowStatePrecondition[]): void {
    for (const precondition of preconditions) {
      const placeholders = precondition.lookupSlugs.map(() => "?").join(", ");
      const rows = this.sqlite
        .prepare(
          `SELECT id, userId, slug, graph, visibility, deleted
           FROM workflow WHERE userId = ? AND slug IN (${placeholders})`,
        )
        .all(precondition.owner, ...precondition.lookupSlugs) as Array<{
        id: string;
        userId: string;
        slug: string;
        graph: string;
        visibility: string;
        deleted: number;
      }>;
      const row = rows.length === 1 ? rows[0] : undefined;
      const actual: ManagedWorkflowState = row
        ? {
            lifecycle: row.deleted ? "deleted" : "present",
            content: {
              graph: JSON.parse(row.graph) as Record<string, unknown>,
              visibility: row.visibility === "public" ? "public" : "private",
            },
          }
        : { lifecycle: "absent" };
      if (
        rows.length > 1 ||
        (precondition.workflowId !== undefined && row?.id !== precondition.workflowId) ||
        !managedWorkflowStatesEqual(actual, precondition.expected)
      ) {
        throw new WorkflowReconciliationStaleError(precondition.owner, precondition.slug);
      }
    }
  }

  private applyWorkflow(operation: WorkflowApplyOperation, now: number): void {
    if (operation.state.lifecycle === "absent") {
      if (operation.workflowId) {
        const result = this.sqlite
          .prepare("DELETE FROM workflow WHERE id = ? AND userId = ?")
          .run(operation.workflowId, operation.owner);
        if (result.changes !== 1) {
          throw new Error(`Workflow ${operation.owner}/${operation.slug} changed during apply`);
        }
      }
      return;
    }
    if (operation.state.lifecycle === "deleted") {
      if (operation.workflowId) {
        const graph = operation.state.content.graph;
        const storedGraph = JSON.stringify({ ...graph, id: operation.workflowId });
        const metadata = (graph.metadata ?? {}) as Record<string, unknown>;
        const result = this.sqlite
          .prepare(
            `UPDATE workflow SET slug = ?, name = ?, description = ?, version = ?, graph = ?,
             visibility = ?, deleted = 1, deletedAt = ?, deletedBy = ?, updatedAt = ?
             WHERE id = ? AND userId = ?`,
          )
          .run(
            operation.slug,
            String(metadata.name ?? operation.slug),
            metadata.description == null ? null : String(metadata.description),
            String(metadata.version ?? "0.0.0"),
            storedGraph,
            operation.state.content.visibility,
            now,
            operation.owner,
            now,
            operation.workflowId,
            operation.owner,
          );
        if (result.changes !== 1) {
          throw new Error(`Workflow ${operation.owner}/${operation.slug} changed during apply`);
        }
      }
      return;
    }

    const graph = operation.state.content.graph;
    const workflowId = operation.workflowId ?? randomUUID();
    const storedGraph = JSON.stringify({ ...graph, id: workflowId });
    const metadata = (graph.metadata ?? {}) as Record<string, unknown>;
    const validation = operation.validation ?? { isValid: true, errors: [] };
    if (operation.workflowId) {
      const result = this.sqlite
        .prepare(
          `UPDATE workflow SET slug = ?, name = ?, description = ?, version = ?, graph = ?,
             visibility = ?, deleted = 0, deletedAt = NULL, deletedBy = NULL,
             isValid = ?, validationErrors = ?, validatedAt = ?, updatedAt = ?
           WHERE id = ? AND userId = ?`,
        )
        .run(
          operation.slug,
          String(metadata.name ?? operation.slug),
          metadata.description == null ? null : String(metadata.description),
          String(metadata.version ?? "0.0.0"),
          storedGraph,
          operation.state.content.visibility,
          validation.isValid ? 1 : 0,
          JSON.stringify(validation.errors),
          now,
          now,
          workflowId,
          operation.owner,
        );
      if (result.changes !== 1) {
        throw new Error(`Workflow ${operation.owner}/${operation.slug} changed during apply`);
      }
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO workflow
          (id, userId, slug, name, description, version, graph, visibility, deleted,
           createdAt, updatedAt, isValid, validationErrors, validatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflowId,
        operation.owner,
        operation.slug,
        String(metadata.name ?? operation.slug),
        metadata.description == null ? null : String(metadata.description),
        String(metadata.version ?? "0.0.0"),
        storedGraph,
        operation.state.content.visibility,
        now,
        now,
        validation.isValid ? 1 : 0,
        JSON.stringify(validation.errors),
        now,
      );
  }
}

export const WORKFLOW_RECONCILIATION_ERROR_CODE = "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED";

export interface WorkflowReconciliationStatus {
  status: "ok" | "error";
  code: typeof WORKFLOW_RECONCILIATION_ERROR_CODE;
  conflicts: WorkflowReconciliationConflictRecord[];
}

export type WorkflowReconciliationConflictSummary = Omit<
  WorkflowReconciliationConflictRecord,
  | "previous"
  | "current"
  | "incoming"
  | "currentWorkflowId"
  | "currentWorkflowSlug"
  | "previousManagedSlug"
  | "revision"
>;

export interface WorkflowReconciliationStatusSummary {
  status: "ok" | "error";
  code: typeof WORKFLOW_RECONCILIATION_ERROR_CODE;
  conflicts: WorkflowReconciliationConflictSummary[];
}

export function getWorkflowReconciliationStatus(
  sqlite: Database.Database,
): WorkflowReconciliationStatus {
  const conflicts = new WorkflowReconciliationRepository(sqlite).listConflicts();
  return {
    status: conflicts.length === 0 ? "ok" : "error",
    code: WORKFLOW_RECONCILIATION_ERROR_CODE,
    conflicts,
  };
}

export function getWorkflowReconciliationStatusSummary(
  sqlite: Database.Database,
): WorkflowReconciliationStatusSummary {
  const conflicts = new WorkflowReconciliationRepository(sqlite).listConflictSummaries();
  return {
    status: conflicts.length === 0 ? "ok" : "error",
    code: WORKFLOW_RECONCILIATION_ERROR_CODE,
    conflicts,
  };
}
