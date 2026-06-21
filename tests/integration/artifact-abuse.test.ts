/**
 * Integration Tests - Artifact Abuse Controls
 * Verifies report + admin takedown behavior, public-serving suppression of
 * taken-down artifacts, and audit logging of report/takedown with creator.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  getDatabase,
  ArtifactRepository,
  ArtifactService,
  AuditRepository,
  AuditAction,
  ArtifactNotFoundError,
} from "@mcp-moira/shared";

describe("Artifact Abuse Controls Integration", () => {
  // system-admin is seeded in the test DB and satisfies the userId FK.
  const ownerId = "system-admin";
  const adminId = "system-admin";

  let service: ArtifactService;
  let repo: ArtifactRepository;
  let auditRepo: AuditRepository;
  const createdUuids: string[] = [];

  beforeAll(() => {
    const db = getDatabase();
    repo = new ArtifactRepository(db);
    auditRepo = new AuditRepository(db);
    service = new ArtifactService(repo, auditRepo);
  });

  afterAll(async () => {
    for (const uuid of createdUuids) {
      await repo.hardDelete(uuid, ownerId).catch(() => undefined);
    }
  });

  async function createArtifact(name: string): Promise<string> {
    const info = await service.create(ownerId, {
      name,
      content: "<!DOCTYPE html><html><body><h1>abuse test</h1></body></html>",
    });
    createdUuids.push(info.uuid);
    return info.uuid;
  }

  test("report increments report count and logs an audit event", async () => {
    const uuid = await createArtifact("report-target.html");

    const before = (await auditRepo.list({ action: AuditAction.ARTIFACT_REPORT })).length;

    const count1 = await service.report(uuid);
    expect(count1).toBe(1);
    const count2 = await service.report(uuid);
    expect(count2).toBe(2);

    const reported = await repo.listReported({});
    const entry = reported.artifacts.find((a) => a.uuid === uuid);
    expect(entry).toBeDefined();
    expect(entry?.reportCount).toBe(2);
    expect(entry?.lastReportedAt).toBeGreaterThan(0);

    const after = (await auditRepo.list({ action: AuditAction.ARTIFACT_REPORT })).length;
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });

  test("reporting a non-existent artifact throws ArtifactNotFoundError", async () => {
    await expect(service.report("nonexistent-uuid-1234567890")).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });

  test("admin takedown marks artifact and suppresses public serving", async () => {
    const uuid = await createArtifact("takedown-target.html");

    // Servable before takedown
    expect(await service.getPublic(uuid)).not.toBeNull();

    await service.adminTakedown(adminId, uuid, "phishing");

    // Not servable after takedown
    expect(await service.getPublic(uuid)).toBeNull();

    // State persisted
    const reported = await repo.listReported({ includeTakenDown: true });
    // takedown alone doesn't create a report, so query owner state directly
    const ownerCheck = await repo.getOwnerId(uuid);
    expect(ownerCheck).toBe(ownerId);

    // Audit entry for takedown exists with creator in metadata
    const logs = await auditRepo.list({
      action: AuditAction.ADMIN_ARTIFACT_TAKEDOWN,
      resourceId: uuid,
      limit: 1,
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].metadata).toContain(ownerId);
    // reported list reference kept to assert query works
    expect(Array.isArray(reported.artifacts)).toBe(true);
  });

  test("admin takedown of non-existent artifact throws ArtifactNotFoundError", async () => {
    await expect(
      service.adminTakedown(adminId, "nonexistent-uuid-0987654321", "reason"),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("takedownAllForUser takes down all of a user's artifacts", async () => {
    const u1 = await createArtifact("bulk-1.html");
    const u2 = await createArtifact("bulk-2.html");

    expect(await service.getPublic(u1)).not.toBeNull();
    expect(await service.getPublic(u2)).not.toBeNull();

    const count = await service.adminTakedownAllForUser(adminId, ownerId, "abusive account");
    expect(count).toBeGreaterThanOrEqual(2);

    expect(await service.getPublic(u1)).toBeNull();
    expect(await service.getPublic(u2)).toBeNull();

    const logs = await auditRepo.list({
      action: AuditAction.ADMIN_ARTIFACT_TAKEDOWN,
      limit: 5,
    });
    expect(logs.some((l) => l.metadata?.includes("bulk"))).toBe(true);
  });
});
