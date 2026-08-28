import { getBaseUrl, TokenManager, ValidationError, type WorkflowToken } from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";
import {
  normalizeProgressVisualOptions,
  type ProgressVisualOptions,
} from "../utils/execution-progress-visual.js";
import { renderExecutionProgressImage } from "../utils/execution-progress-image.js";
import { randomUUID } from "node:crypto";

export interface ProgressImageGrant {
  downloadUrl: string;
  expiresAt: number;
  mimeType: "image/png";
  options: Required<ProgressVisualOptions>;
  workflowVersion: string;
  executionRevision: number;
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
    private readonly renderer: typeof renderExecutionProgressImage = renderExecutionProgressImage,
  ) {}

  async mint(
    executionId: string,
    ownerUserId: string,
    options: ProgressVisualOptions = {},
  ): Promise<ProgressImageGrant> {
    const execution = await this.repository.getExecution(executionId);
    if (!execution || execution.userId !== ownerUserId) throw new ValidationError("Access denied");
    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    if (!graph?.progress) throw new ValidationError("Workflow has no progress graph");
    const normalized = normalizeProgressVisualOptions(options);
    const ttlMs = TokenManager.PROGRESS_IMAGE_TTL_MS;
    const issuedAt = Date.now();
    const token = this.tokens.createProgressImageToken(
      execution.executionId,
      execution.workflowId,
      execution.userId,
      graph.metadata.version,
      execution.revision,
      JSON.stringify(normalized),
      ttlMs,
    );
    return {
      downloadUrl: `${this.baseUrl().replace(/\/$/, "")}/api/public/execution-progress-image/${token}`,
      expiresAt: issuedAt + ttlMs,
      mimeType: "image/png",
      options: normalized,
      workflowVersion: graph.metadata.version,
      executionRevision: execution.revision,
    };
  }

  async redeem(token: string): Promise<{ png: Buffer; claimId: string } | null> {
    const grant = this.tokens.validateToken(token, "progress-image");
    if (
      !grant?.executionId ||
      !grant.workflowId ||
      grant.executionRevision === null ||
      !grant.workflowVersion ||
      !grant.optionsJson
    )
      return null;
    const execution = await this.repository.getExecution(grant.executionId);
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
    try {
      options = JSON.parse(grant.optionsJson) as ProgressVisualOptions;
    } catch {
      return null;
    }
    const claimId = randomUUID();
    if (!this.tokens.reserveProgressImageToken(token, claimId)) return null;
    try {
      const rendered = await this.renderer(graph, execution, options);
      if (!rendered) {
        this.tokens.releaseProgressImageToken(token, claimId);
        return null;
      }
      return { png: rendered.buffer, claimId };
    } catch (error) {
      this.tokens.releaseProgressImageToken(token, claimId);
      throw error;
    }
  }

  complete(token: string, claimId: string): boolean {
    return this.tokens.completeProgressImageToken(token, claimId);
  }

  release(token: string, claimId: string): boolean {
    return this.tokens.releaseProgressImageToken(token, claimId);
  }
}
