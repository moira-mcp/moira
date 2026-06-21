/**
 * Integration tests for admin-user resolution (UserRepository.getAdminUserIds /
 * UserService.getAdminUserIds). Used to fan out abuse-report Telegram
 * notifications to all administrators.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { getDatabase, user, UserRepository, AuditRepository, UserService } from "@mcp-moira/shared";
import { inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

const generateId = () => randomUUID().replace(/-/g, "");
const db = getDatabase();

describe("Admin user resolution (getAdminUserIds)", () => {
  const repo = new UserRepository(db);
  const service = new UserService(repo, new AuditRepository(db));

  let activeAdminId: string;
  let blockedAdminId: string;
  let regularUserId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const now = new Date().toISOString();
    const make = async (isAdmin: boolean, blocked: boolean, label: string) => {
      const id = generateId();
      await db.insert(user).values({
        id,
        email: `${label}-${id}@test.com`,
        name: label,
        handle: `${label}-${id}`,
        emailVerified: true,
        isAdmin,
        blocked,
        passwordResetRequired: false,
        createdAt: now,
        updatedAt: now,
      });
      createdIds.push(id);
      return id;
    };

    activeAdminId = await make(true, false, "active-admin");
    blockedAdminId = await make(true, true, "blocked-admin");
    regularUserId = await make(false, false, "regular");
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await db.delete(user).where(inArray(user.id, createdIds));
    }
  });

  it("repository returns active admins and excludes non-admins and blocked admins", async () => {
    const ids = await repo.getAdminUserIds();

    expect(ids).toContain(activeAdminId);
    expect(ids).not.toContain(regularUserId);
    expect(ids).not.toContain(blockedAdminId);
  });

  it("service delegates to the repository and returns the same admin set", async () => {
    const repoIds = await repo.getAdminUserIds();
    const serviceIds = await service.getAdminUserIds();

    expect([...serviceIds].sort()).toEqual([...repoIds].sort());
    expect(serviceIds).toContain(activeAdminId);
  });
});
