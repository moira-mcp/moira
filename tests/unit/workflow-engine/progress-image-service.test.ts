import { describe, expect, jest, test } from "@jest/globals";
import {
  ProgressImageService,
  type ProgressImageTokenStore,
  type WorkflowExecution,
  type WorkflowGraph,
  type IDataRepository,
} from "@mcp-moira/workflow-engine";
import type { WorkflowToken } from "@mcp-moira/shared";

function fixture() {
  const graph: WorkflowGraph = {
    metadata: { name: "Progress", version: "2.0.0", description: "" },
    progress: { nodes: [{ id: "work", label: "Work" }] },
    nodes: [
      { id: "start", type: "start", connections: { default: "work" } },
      {
        id: "work",
        type: "agent-directive",
        progressNodeId: "work",
        directive: "Work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
  const execution: WorkflowExecution = {
    executionId: "execution",
    workflowId: "workflow",
    userId: "owner",
    currentNodeId: "work",
    waitingForInputNodeId: "work",
    status: "running",
    revision: 4,
    createdAt: 1,
    updatedAt: 1,
    globalContext: {
      variables: {},
      nodeStates: {},
      executionId: "execution",
      workflowId: "workflow",
      userId: "owner",
    },
  };
  let grant: WorkflowToken | null = null;
  let claimed = false;
  let reserved: string | null = null;
  const tokens: ProgressImageTokenStore = {
    createProgressImageToken(
      executionId,
      workflowId,
      userId,
      workflowVersion,
      executionRevision,
      optionsJson,
      ttlMs,
    ) {
      const createdAt = Date.now();
      grant = {
        token: "opaque",
        executionId,
        workflowId,
        userId,
        workflowVersion,
        executionRevision,
        optionsJson,
        nodeId: null,
        type: "progress-image",
        expiresAt: createdAt + (ttlMs ?? 1000),
        used: false,
        createdAt,
      };
      return "opaque";
    },
    validateToken() {
      return claimed ? null : grant;
    },
    reserveProgressImageToken(_token, claimId) {
      if (claimed || reserved) return false;
      reserved = claimId;
      return true;
    },
    completeProgressImageToken(_token, claimId) {
      if (reserved !== claimId) return false;
      reserved = null;
      claimed = true;
      return true;
    },
    releaseProgressImageToken(_token, claimId) {
      if (reserved !== claimId) return false;
      reserved = null;
      return true;
    },
  };
  const repository = {
    getExecution: async () => execution,
    getWorkflowGraph: async () => graph,
  } as unknown as IDataRepository;
  return {
    graph,
    execution,
    tokens,
    repository,
    wasClaimed: () => claimed,
    isReserved: () => reserved !== null,
    currentGrant: () => grant,
  };
}

describe("progress image grants", () => {
  test("mints normalized revision/version-bound metadata and redeems once", async () => {
    const f = fixture();
    const service = new ProgressImageService(f.repository, f.tokens, () => "https://moira.test/");
    const minted = await service.mint("execution", "owner", { theme: "dark", viewportWidth: 200 });
    expect(minted).toMatchObject({
      downloadUrl: "https://moira.test/api/public/execution-progress-image/opaque",
      workflowVersion: "2.0.0",
      executionRevision: 4,
      options: { theme: "dark", viewportWidth: 480 },
      mimeType: "image/png",
    });
    const redemption = await service.redeem("opaque");
    expect(redemption?.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await service.redeem("opaque")).toBeNull();
    expect(service.complete("opaque", redemption!.claimId)).toBe(true);
    expect(await service.redeem("opaque")).toBeNull();
  });

  test("does not consume a grant when rendering fails and rejects stale revision", async () => {
    const f = fixture();
    const failing = new ProgressImageService(
      f.repository,
      f.tokens,
      () => "https://moira.test",
      async () => {
        throw new Error("render failed");
      },
    );
    await failing.mint("execution", "owner");
    await expect(failing.redeem("opaque")).rejects.toThrow("render failed");
    expect(f.wasClaimed()).toBe(false);
    expect(f.isReserved()).toBe(false);
    f.execution.revision++;
    const normal = new ProgressImageService(f.repository, f.tokens);
    expect(await normal.redeem("opaque")).toBeNull();
    expect(f.wasClaimed()).toBe(false);
  });

  test("reports an expiry no later than the persisted token expiry", async () => {
    const f = fixture();
    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValueOnce(100).mockReturnValueOnce(110).mockReturnValue(120);
    const minted = await new ProgressImageService(f.repository, f.tokens).mint(
      "execution",
      "owner",
    );
    expect(minted.expiresAt).toBe(100 + 5 * 60 * 1000);
    expect(minted.expiresAt).toBeLessThanOrEqual(f.currentGrant()!.expiresAt);
    clock.mockRestore();
  });
});
