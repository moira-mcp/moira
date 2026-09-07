import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  CommunicationAttachmentGrantService,
  CommunicationGrantQuotaError,
  MAX_OUTSTANDING_COMMUNICATION_GRANTS_GLOBAL,
  MAX_OUTSTANDING_COMMUNICATION_GRANTS_PER_USER,
} from "../../../packages/shared/src/services/communication-attachment-grant-service.js";

function createTable(db: Database.Database): void {
  db.exec(`CREATE TABLE communication_attachment_grant (
    token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
    audience TEXT NOT NULL, purpose TEXT NOT NULL, message TEXT NOT NULL, format TEXT NOT NULL,
    silent INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
    declared_size INTEGER NOT NULL, state TEXT NOT NULL, claim_id TEXT, claimed_at INTEGER,
    completed_at INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
}

describe("CommunicationAttachmentGrantService", () => {
  let db: Database.Database;
  let now: number;
  let service: CommunicationAttachmentGrantService;

  beforeEach(() => {
    db = new Database(":memory:");
    createTable(db);
    now = 1_800_000_000_000;
    service = new CommunicationAttachmentGrantService(db, () => now);
  });
  afterEach(() => db.close());

  const input = (userId = "user-a") => ({
    userId,
    message: "private body",
    kind: "document" as const,
    filename: "report.pdf",
    mimeType: "application/pdf",
    declaredSize: 42,
  });

  it("stores only a digest and binds an atomic claim to its owner", () => {
    const created = service.create(input());
    const stored = db
      .prepare(
        "SELECT token_digest AS digest, user_id AS userId, state FROM communication_attachment_grant",
      )
      .get() as { digest: string; userId: string; state: string };
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.digest).not.toBe(created.grant);
    expect(service.reserve(created.grant, "user-b")).toBeNull();
    const claimed = service.reserve(created.grant, "user-a");
    expect(claimed).toEqual(
      expect.objectContaining({ userId: "user-a", message: "private body", declaredSize: 42 }),
    );
    expect(service.reserve(created.grant, "user-a")).toBeNull();
  });

  it("allows a pre-delivery release but makes a completed grant terminal", () => {
    const created = service.create(input());
    const first = service.reserve(created.grant, "user-a")!;
    expect(service.release(first.tokenDigest, first.claimId)).toBe(true);
    const second = service.reserve(created.grant, "user-a")!;
    expect(service.complete(second.tokenDigest, second.claimId)).toBe(true);
    expect(service.reserve(created.grant, "user-a")).toBeNull();
  });

  it("enforces the per-user outstanding quota atomically", () => {
    const grants: string[] = [];
    for (let index = 0; index < MAX_OUTSTANDING_COMMUNICATION_GRANTS_PER_USER; index++) {
      grants.push(service.create(input()).grant);
    }
    expect(() => service.create(input())).toThrow(CommunicationGrantQuotaError);
    expect(() => service.create(input("user-b"))).not.toThrow();
    const claimed = service.reserve(grants[0], "user-a")!;
    service.complete(claimed.tokenDigest, claimed.claimId);
    expect(() => service.create(input())).not.toThrow();
  });

  it("enforces the installation-wide outstanding quota across independent users", () => {
    for (let index = 0; index < MAX_OUTSTANDING_COMMUNICATION_GRANTS_GLOBAL; index++) {
      service.create(input(`user-${index}`));
    }
    expect(() => service.create(input("one-more-user"))).toThrow(CommunicationGrantQuotaError);
  });

  it("expires grants without revealing a reusable credential", () => {
    const created = service.create(input());
    now += 5 * 60 * 1000;
    expect(service.reserve(created.grant, "user-a")).toBeNull();
    service.cleanup();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM communication_attachment_grant").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("refuses a grant whose fixed audience or purpose was altered", () => {
    const wrongAudience = service.create(input());
    db.prepare("UPDATE communication_attachment_grant SET audience = 'other'").run();
    expect(service.reserve(wrongAudience.grant, "user-a")).toBeNull();

    db.prepare("DELETE FROM communication_attachment_grant").run();
    const wrongPurpose = service.create(input());
    db.prepare("UPDATE communication_attachment_grant SET purpose = 'trusted'").run();
    expect(service.reserve(wrongPurpose.grant, "user-a")).toBeNull();
  });
});
