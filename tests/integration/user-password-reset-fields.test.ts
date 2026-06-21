/**
 * Unit Tests - User Password Reset Fields
 * Tests schema changes for password reset functionality (migration 0008)
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { getDatabase, closeDatabase, user } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@mcp-moira/shared";

describe("User Password Reset Fields", () => {
  let db: BetterSQLite3Database<typeof schema>;
  const testUserId = "test-user-password-reset";
  const adminUserId = "system-admin";

  beforeEach(async () => {
    db = getDatabase();

    // Clean up test user if exists
    await db.delete(user).where(eq(user.id, testUserId));

    // Create test user
    await db.insert(user).values({
      id: testUserId,
      email: "test-password-reset@example.com",
      name: "Test User",
      handle: testUserId,
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    // Clean up
    await db.delete(user).where(eq(user.id, testUserId));
    closeDatabase();
  });

  test("passwordResetRequired field exists with default value false", async () => {
    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result).toHaveLength(1);
    expect(result[0].passwordResetRequired).toBe(false);
  });

  test("passwordResetRequired field can be set to true", async () => {
    await db.update(user).set({ passwordResetRequired: true }).where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequired).toBe(true);
  });

  test("passwordResetRequestedAt field exists and accepts ISO date string", async () => {
    const now = new Date().toISOString();

    await db.update(user).set({ passwordResetRequestedAt: now }).where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequestedAt).toBe(now);
  });

  test("passwordResetRequestedAt field defaults to null", async () => {
    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequestedAt).toBeNull();
  });

  test("passwordResetRequestedBy field exists and accepts userId reference", async () => {
    await db
      .update(user)
      .set({ passwordResetRequestedBy: adminUserId })
      .where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequestedBy).toBe(adminUserId);
  });

  test("passwordResetRequestedBy field defaults to null", async () => {
    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequestedBy).toBeNull();
  });

  test("all three fields can be set together", async () => {
    const now = new Date().toISOString();

    await db
      .update(user)
      .set({
        passwordResetRequired: true,
        passwordResetRequestedAt: now,
        passwordResetRequestedBy: adminUserId,
      })
      .where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequired).toBe(true);
    expect(result[0].passwordResetRequestedAt).toBe(now);
    expect(result[0].passwordResetRequestedBy).toBe(adminUserId);
  });

  test("fields can be cleared after password reset", async () => {
    const now = new Date().toISOString();

    // Set fields
    await db
      .update(user)
      .set({
        passwordResetRequired: true,
        passwordResetRequestedAt: now,
        passwordResetRequestedBy: adminUserId,
      })
      .where(eq(user.id, testUserId));

    // Clear fields (simulating password reset completion)
    await db
      .update(user)
      .set({
        passwordResetRequired: false,
        passwordResetRequestedAt: null,
        passwordResetRequestedBy: null,
      })
      .where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(result[0].passwordResetRequired).toBe(false);
    expect(result[0].passwordResetRequestedAt).toBeNull();
    expect(result[0].passwordResetRequestedBy).toBeNull();
  });

  test("passwordResetRequired is boolean type", async () => {
    await db.update(user).set({ passwordResetRequired: true }).where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(typeof result[0].passwordResetRequired).toBe("boolean");
  });

  test("passwordResetRequestedAt is string type when set", async () => {
    const now = new Date().toISOString();

    await db.update(user).set({ passwordResetRequestedAt: now }).where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(typeof result[0].passwordResetRequestedAt).toBe("string");
  });

  test("passwordResetRequestedBy is string type when set", async () => {
    await db
      .update(user)
      .set({ passwordResetRequestedBy: adminUserId })
      .where(eq(user.id, testUserId));

    const result = await db.select().from(user).where(eq(user.id, testUserId));

    expect(typeof result[0].passwordResetRequestedBy).toBe("string");
  });
});
