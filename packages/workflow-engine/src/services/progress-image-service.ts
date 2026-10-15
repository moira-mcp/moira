import {
  getBaseUrl,
  metadataRevision,
  TokenManager,
  ValidationError,
  type WorkflowToken,
  communicationOwnerReceiptSchema,
} from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";
import {
  normalizeProgressVisualOptions,
  resolveProgressBlockIds,
  type ProgressVisualOptions,
} from "../utils/execution-progress-visual.js";
import { deriveProcess } from "../utils/process-derivation.js";
import {
  getActiveCommunicationFileOwner,
  type CommunicationFileOwner,
} from "./user-communication-provider.js";
import { ProgressStatisticsService, statisticsForRun } from "./progress-statistics-service.js";
import { randomUUID } from "node:crypto";
import { runPageUrl } from "../utils/notification-text.js";

export interface ProgressImageGrant {
  downloadUrl: string;
  expiresAt: number;
  mimeType: "image/png";
  options: Required<ProgressVisualOptions>;
  workflowVersion: string;
  executionRevision: number;
  contextRevision: string;
  taskIdentityRevision: string;
}

export interface ProgressImageTokenStore {
  createProgressImageToken(
    executionId: string,
    workflowId: string,
    userId: string,
    workflowVersion: string,
    executionRevision: number,
    optionsJson: string,
    ttlMs?: number,
  ): string;
  validateToken(token: string, expectedType: "progress-image"): WorkflowToken | null;
  reserveProgressImageToken(token: string, claimId: string): boolean;
  completeProgressImageToken(token: string, claimId: string): boolean;
  releaseProgressImageToken(token: string, claimId: string): boolean;
}

export class ProgressImageService {
  constructor(
    private readonly repository: IDataRepository,
    private readonly tokens: ProgressImageTokenStore = TokenManager.getInstance(),
    private readonly baseUrl: () => string = getBaseUrl,
    private readonly fileOwner?: CommunicationFileOwner,
    private readonly statistics: Pick<
      ProgressStatisticsService,
      "forVersion"
    > = new ProgressStatisticsService(repository),
  ) {}

  async mint(
    executionId: string,
    ownerUserId: string,
    options: ProgressVisualOptions = {},
    deviceId?: string,
  ): Promise<ProgressImageGrant> {
    // The caller decides whether this user may act on the execution; what this service enforces is
    // the binding the minted token depends on — the execution it names is the one it was minted
    // for, owned by the identity the token will carry.
    let execution = await this.repository.getExecution(executionId);
    if (!execution || execution.userId !== ownerUserId) throw new ValidationError("Access denied");
    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    if (!graph?.progress) throw new ValidationError("Workflow has no progress graph");
    const initialWorkflowId = execution.workflowId;
    execution = await this.repository.getExecution(executionId);
    if (
      !execution ||
      execution.userId !== ownerUserId ||
      execution.workflowId !== initialWorkflowId
    )
      throw new ValidationError("Access denied");
    const requested = normalizeProgressVisualOptions(options);
    // `hide` and `collapse` name blocks or authored nodes of this workflow's process; a name the
    // image could not honour is refused now, so a token never carries one.
    const process = deriveProcess(graph);
    const resolve = (ids: string[], field: "hide" | "collapse"): string[] => {
      if (!ids.length) return [];
      if (!process)
        throw new ValidationError(`${field} names blocks, but the workflow has no process`);
      const { blockIds, unknown } = resolveProgressBlockIds(process, ids);
      if (unknown.length)
        throw new ValidationError(
          `${field} names no block or node of this workflow: ${unknown.join(", ")}`,
        );
      return blockIds;
    };
    const normalized = {
      ...requested,
      hide: resolve(requested.hide, "hide"),
      collapse: resolve(requested.collapse, "collapse"),
    };
    const ttlMs = TokenManager.PROGRESS_IMAGE_TTL_MS;
    const issuedAt = Date.now();
    const contextRevision = metadataRevision(execution.globalContext);
    const taskIdentityRevision = metadataRevision(execution.taskIdentity ?? null);
    const selected = await (this.fileOwner ?? getActiveCommunicationFileOwner()).select(
      ownerUserId,
      deviceId,
    );
    const token = this.tokens.createProgressImageToken(
      execution.executionId,
      execution.workflowId,
      execution.userId,
      graph.metadata.version,
      execution.revision,
      JSON.stringify({
        options: normalized,
        contextRevision,
        taskIdentity: execution.taskIdentity ?? null,
        taskIdentityRevision,
        deviceId: selected.deviceId,
      }),
      ttlMs,
    );
    return {
      downloadUrl: `${this.baseUrl().replace(/\/$/, "")}/api/public/execution-progress-image/${token}`,
      expiresAt: issuedAt + ttlMs,
      mimeType: "image/png",
      options: normalized,
      workflowVersion: graph.metadata.version,
      executionRevision: execution.revision,
      contextRevision,
      taskIdentityRevision,
    };
  }

  async redeem(
    token: string,
  ): Promise<{ referenceId: string; claimId: string; userId: string } | null> {
    const grant = this.tokens.validateToken(token, "progress-image");
    if (
      !grant?.executionId ||
      !grant.workflowId ||
      grant.executionRevision === null ||
      !grant.workflowVersion ||
      !grant.optionsJson
    )
      return null;
    let execution = await this.repository.getExecution(grant.executionId);
    if (
      !execution ||
      execution.userId !== grant.userId ||
      execution.workflowId !== grant.workflowId ||
      execution.revision !== grant.executionRevision
    )
      return null;
    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    if (!graph?.progress || graph.metadata.version !== grant.workflowVersion) return null;
    let options: ProgressVisualOptions;
    let contextRevision: string;
    let taskIdentityRevision: string;
    let deviceId: string;
    try {
      const stored = JSON.parse(grant.optionsJson) as {
        options: ProgressVisualOptions;
        contextRevision: string;
        taskIdentityRevision: string;
        deviceId: string;
      };
      if (
        !stored.options ||
        typeof stored.contextRevision !== "string" ||
        typeof stored.taskIdentityRevision !== "string" ||
        typeof stored.deviceId !== "string"
      )
        return null;
      contextRevision = stored.contextRevision;
      taskIdentityRevision = stored.taskIdentityRevision;
      options = stored.options;
      deviceId = stored.deviceId;
    } catch {
      return null;
    }
    const currentBinding = async () => {
      const current = await this.repository.getExecution(grant.executionId!);
      return current &&
        current.userId === grant.userId &&
        current.workflowId === grant.workflowId &&
        current.revision === grant.executionRevision &&
        metadataRevision(current.globalContext) === contextRevision &&
        metadataRevision(current.taskIdentity ?? null) === taskIdentityRevision
        ? current
        : null;
    };
    execution = await currentBinding();
    if (!execution) return null;
    const claimId = randomUUID();
    if (!this.tokens.reserveProgressImageToken(token, claimId)) return null;
    try {
      const statistics = await statisticsForRun(this.statistics, graph, execution);
      if (!(await currentBinding())) {
        this.tokens.releaseProgressImageToken(token, claimId);
        return null;
      }
      const digest = metadataRevision(["progress-image", token]);
      const requestId = `ws1-${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const raw = await (this.fileOwner ?? getActiveCommunicationFileOwner()).submit(
        grant.userId,
        {
          action: "publish",
          requestId,
          source: {
            type: "progress",
            descriptor: {
              kind: "map",
              graph: graph as unknown as Record<string, unknown>,
              run: execution as unknown as Record<string, unknown>,
              options: options as Record<string, unknown>,
              statistics: statistics as unknown as Record<string, unknown> | null,
              renderContext: { runUrl: runPageUrl(execution.globalContext) },
            },
          },
        },
        deviceId,
      );
      const receipt = communicationOwnerReceiptSchema.passthrough().parse(raw);
      if (!receipt.outcome?.ok)
        throw Object.assign(
          new Error("Collect the original progress publication; its outcome is unconfirmed."),
          { code: "COMMUNICATION_OUTCOME_UNCONFIRMED", requestId, deviceId },
        );
      if (!(await currentBinding())) {
        this.tokens.releaseProgressImageToken(token, claimId);
        return null;
      }
      return {
        referenceId: receipt.outcome.result.file.referenceId,
        claimId,
        userId: grant.userId,
      };
    } catch (error) {
      this.tokens.releaseProgressImageToken(token, claimId);
      throw error;
    }
  }

  open(redemption: { referenceId: string; userId: string }) {
    return (this.fileOwner ?? getActiveCommunicationFileOwner()).openPublication(
      redemption.userId,
      redemption.referenceId,
    );
  }

  complete(token: string, claimId: string): boolean {
    return this.tokens.completeProgressImageToken(token, claimId);
  }

  release(token: string, claimId: string): boolean {
    return this.tokens.releaseProgressImageToken(token, claimId);
  }
}
