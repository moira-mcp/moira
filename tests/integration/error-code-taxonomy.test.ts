/**
 * Integration: the HTTP error boundary surfaces SPECIFIC domain error codes (defect D-N3),
 * not a blanket INTERNAL_ERROR, while keeping the correct HTTP status. Mounts the real
 * `setupErrorMiddleware` behind tiny routes that throw each domain error and asserts the
 * response `error.code` + status. This is the exact boundary the marketplace routes use
 * (publish/unpublish/rate), so a client/agent can branch on the reason.
 */

import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";

import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";
import {
  WorkflowAlreadyListedError,
  ListingAccessDeniedError,
  WorkflowAccessDeniedError,
  SelfRatingError,
  MarketplaceDisabledError,
  InvalidRatingError,
  WorkflowListedCannotGoPrivateError,
} from "@mcp-moira/shared";

/** Mount a route that throws `err`, behind the real error middleware. */
function appThrowing(err: unknown) {
  const app = express();
  app.get("/x", () => {
    throw err;
  });
  app.use(setupErrorMiddleware());
  return app;
}

async function codeAndStatus(err: unknown): Promise<{ status: number; code: string }> {
  const res = await request(appThrowing(err)).get("/x");
  return { status: res.status, code: res.body?.error?.code };
}

describe("HTTP error taxonomy — specific domain codes (D-N3)", () => {
  it("already-listed → 409 WORKFLOW_ALREADY_LISTED", async () => {
    expect(await codeAndStatus(new WorkflowAlreadyListedError("wf-1"))).toEqual({
      status: 409,
      code: "WORKFLOW_ALREADY_LISTED",
    });
  });

  it("listing not-owner → 403 LISTING_ACCESS_DENIED", async () => {
    expect(await codeAndStatus(new ListingAccessDeniedError("wf-1", "unpublish"))).toEqual({
      status: 403,
      code: "LISTING_ACCESS_DENIED",
    });
  });

  it("workflow not-owner → 403 WORKFLOW_ACCESS_DENIED", async () => {
    expect(await codeAndStatus(new WorkflowAccessDeniedError("wf-1", "user-1", "write"))).toEqual({
      status: 403,
      code: "WORKFLOW_ACCESS_DENIED",
    });
  });

  it("self-rate → 403 SELF_RATING_FORBIDDEN", async () => {
    expect(await codeAndStatus(new SelfRatingError())).toEqual({
      status: 403,
      code: "SELF_RATING_FORBIDDEN",
    });
  });

  it("marketplace disabled → MARKETPLACE_DISABLED (not INTERNAL_ERROR)", async () => {
    const { status, code } = await codeAndStatus(new MarketplaceDisabledError());
    expect(code).toBe("MARKETPLACE_DISABLED");
    expect(status).not.toBe(500);
  });

  it("invalid rating → INVALID_RATING", async () => {
    const { code } = await codeAndStatus(new InvalidRatingError(7));
    expect(code).toBe("INVALID_RATING");
  });

  it("listed-cannot-go-private → 409 WORKFLOW_LISTED_CANNOT_GO_PRIVATE", async () => {
    expect(await codeAndStatus(new WorkflowListedCannotGoPrivateError("wf-1"))).toEqual({
      status: 409,
      code: "WORKFLOW_LISTED_CANNOT_GO_PRIVATE",
    });
  });

  it("none of the domain codes collapse to the generic INTERNAL_ERROR", async () => {
    for (const err of [
      new WorkflowAlreadyListedError("a"),
      new ListingAccessDeniedError("a", "publish"),
      new SelfRatingError(),
      new MarketplaceDisabledError(),
    ]) {
      const { code } = await codeAndStatus(err);
      expect(code).not.toBe("INTERNAL_ERROR");
    }
  });
});
