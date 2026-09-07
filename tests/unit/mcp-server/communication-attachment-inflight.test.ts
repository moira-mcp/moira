import { describe, expect, it } from "@jest/globals";
import {
  CommunicationAttachmentInflightLimiter,
  MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER,
} from "../../../packages/mcp-server/src/communication-attachment-inflight.js";

describe("communication attachment in-flight admission", () => {
  it("refuses a third concurrent buffer for one user without affecting another user", () => {
    const limiter = new CommunicationAttachmentInflightLimiter();
    const first = limiter.acquire("user-a", 1)!;
    const second = limiter.acquire("user-a", 1)!;
    expect(limiter.acquire("user-a", 1)).toBeNull();
    expect(limiter.acquire("user-b", 1)).not.toBeNull();
    first();
    expect(limiter.acquire("user-a", 1)).not.toBeNull();
    second();
  });

  it("refuses a byte budget overflow and releases a lease idempotently", () => {
    const limiter = new CommunicationAttachmentInflightLimiter();
    const release = limiter.acquire("user-a", MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER)!;
    expect(limiter.acquire("user-a", 1)).toBeNull();
    release();
    release();
    expect(limiter.acquire("user-a", MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER)).not.toBeNull();
  });
});
