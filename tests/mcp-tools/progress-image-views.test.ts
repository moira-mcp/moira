/**
 * The progress image's export parameters on a real Software Development Flow run: the default
 * token renders today's cards, `view: "process"` the aggregated block view, `hide` leaves blocks
 * out (their labels absent from the SVG-derived PNG's model is unit-owned; here the three PNGs are
 * real, distinct and decodable), unknown ids are refused at mint, a token is single-use, and a
 * token minted before the run advances is refused after it — through MCP and HTTP alike.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import sharp from "sharp";
import {
  advanceWorkflowExecution,
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

async function download(url: string): Promise<{ status: number; png: Buffer | null }> {
  const response = await fetch(`${BASE_URL}${new URL(url).pathname}`);
  if (response.status !== 200) return { status: response.status, png: null };
  return { status: 200, png: Buffer.from(await response.arrayBuffer()) };
}

describe("progress image export views", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let cookie: string;
  let run: RunningWorkflowExecution;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    cookie = await signInUser(getTestFetchUrl(), credentials.email, credentials.password);
    run = await startWorkflowExecutionState(client, "moira/software-development-flow", {
      skipTelegramCheck: true,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  test("cards, process and hidden-block images of one run are distinct PNGs; unknown ids are refused at mint", async () => {
    const mint = (extra: Record<string, unknown>) =>
      callMCPTool<any>(client, "session", {
        action: "progress-image-token",
        executionId: run.processId,
        viewportWidth: 960,
        ...extra,
      });
    const cards = await mint({});
    expect(cards.options).toMatchObject({ view: "cards", hide: [], collapse: [] });
    const process = await mint({ view: "process" });
    expect(process.options).toMatchObject({ view: "process" });
    // Node ids resolve to their blocks; the stored option names the block.
    const hidden = await mint({
      view: "process",
      hide: ["health", "notify-plan-approval"],
      collapse: ["finalize"],
    });
    expect(hidden.options).toMatchObject({
      view: "process",
      hide: ["health", "plan-approval"],
      collapse: ["finalize"],
    });

    const images = await Promise.all(
      [cards, process, hidden].map((grant) => download(grant.downloadUrl)),
    );
    expect(images.map((image) => image.status)).toEqual([200, 200, 200]);
    for (const image of images) {
      expect(await sharp(image.png!).metadata()).toMatchObject({ format: "png", width: 960 });
    }
    expect(images[0].png!.equals(images[1].png!)).toBe(false);
    expect(images[1].png!.equals(images[2].png!)).toBe(false);
    // Fewer blocks: the hidden-block image is shorter than the full process view.
    expect((await sharp(images[2].png!).metadata()).height!).toBeLessThan(
      (await sharp(images[1].png!).metadata()).height!,
    );

    // A second use of the same token is refused.
    expect((await download(process.downloadUrl)).status).toBe(401);

    const unknown = await callMCPToolRaw(client, "session", {
      action: "progress-image-token",
      executionId: run.processId,
      hide: ["no-such-block"],
    });
    expect(unknown).toMatch(/hide names no block or node.*no-such-block/);
    const badView = await callMCPToolRaw(client, "session", {
      action: "progress-image-token",
      executionId: run.processId,
      view: "sepia",
    });
    expect(badView).toMatch(/invalid|sepia/i);
  });

  test("HTTP minting accepts the same parameters and a token minted before an advance is refused after it", async () => {
    const mintHttp = async (body: Record<string, unknown>) =>
      fetch(`${BASE_URL}/api/executions/${run.processId}/progress-image-token`, {
        method: "POST",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const invalid = await mintHttp({ view: "process", hide: "health" });
    expect(invalid.status).toBe(400);
    const unknown = await mintHttp({ hide: ["no-such-block"] });
    expect(unknown.status).toBe(400);

    const minted = await mintHttp({ view: "process", hide: ["health"], collapse: ["intake"] });
    expect(minted.status).toBe(200);
    const grant = ((await minted.json()) as { data: any }).data;
    expect(grant.options).toMatchObject({
      view: "process",
      hide: ["health"],
      collapse: ["intake"],
    });

    // Advance the run past intake: the grant's step revision is stale.
    const advanced = await advanceWorkflowExecution(client, run, {
      workspace_path: `./moira-ws/software-development-flow-${run.processId}/`,
      operating_mode: "autonomous",
      visual_validation_preference: "disabled",
      progress_intake_outcome: "Task and repository context captured",
    });
    expect(advanced).toContain("Step attempt ID:");
    expect((await download(grant.downloadUrl)).status).toBe(401);

    // A fresh process-view token of the advanced run renders.
    const fresh = await mintHttp({ view: "process" });
    expect(fresh.status).toBe(200);
    const freshGrant = ((await fresh.json()) as { data: any }).data;
    expect(freshGrant.executionRevision).toBeGreaterThan(grant.executionRevision);
    expect((await download(freshGrant.downloadUrl)).status).toBe(200);
  });
});
