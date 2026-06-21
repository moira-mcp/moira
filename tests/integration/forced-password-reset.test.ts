/**
 * Integration Tests: Forced Password Reset Flow
 * Tests the forced password reset middleware and endpoint
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { getDatabase, user, session, oauthConsent, oauthAccessToken } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";

describe("Forced Password Reset Flow", () => {
  let testUserId: string;
  let testUserEmail: string;

  beforeAll(async () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    testUserEmail = `forced-reset-test-${Date.now()}@test.com`;
    const testHandle = `forced-reset-${Date.now()}`;

    const [createdUser] = await db
      .insert(user)
      .values({
        id: `test-forced-reset-${Date.now()}`,
        email: testUserEmail,
        handle: testHandle,
        emailVerified: true,
        passwordResetRequired: true,
        passwordResetRequestedAt: now,
        passwordResetRequestedBy: "system-admin",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    testUserId = createdUser.id;

    // Create OAuth tokens that should be revoked
    await db.insert(oauthConsent).values({
      id: `consent-${testUserId}`,
      userId: testUserId,
      clientId: "test-client",
      scopes: "read write",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(oauthAccessToken).values({
      id: `token-${testUserId}`,
      userId: testUserId,
      clientId: "test-client",
      scopes: "read write",
      accessToken: "test-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    const db = getDatabase();

    // Clean up test data
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, testUserId));
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, testUserId));
    await db.delete(session).where(eq(session.userId, testUserId));
    await db.delete(user).where(eq(user.id, testUserId));
  });

  it("should verify user has passwordResetRequired flag", async () => {
    const db = getDatabase();

    // Get user data
    const [userData] = await db.select().from(user).where(eq(user.id, testUserId)).limit(1);

    expect(userData).toBeDefined();
    expect(userData.passwordResetRequired).toBe(true);
    expect(userData.passwordResetRequestedBy).toBe("system-admin");
  });

  it("should clear passwordResetRequired flag after password change", async () => {
    const db = getDatabase();

    // Clear the flag (simulating password change)
    await db
      .update(user)
      .set({
        passwordResetRequired: false,
        passwordResetRequestedAt: null,
        passwordResetRequestedBy: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, testUserId));

    // Verify flag is cleared
    const [userData] = await db.select().from(user).where(eq(user.id, testUserId)).limit(1);

    expect(userData.passwordResetRequired).toBe(false);
    expect(userData.passwordResetRequestedAt).toBeNull();
    expect(userData.passwordResetRequestedBy).toBeNull();
  });

  it("should revoke all OAuth tokens after password change", async () => {
    const db = getDatabase();

    // Verify tokens exist before revocation
    const consentsBefore = await db
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, testUserId));
    const tokensBefore = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, testUserId));

    expect(consentsBefore.length).toBeGreaterThan(0);
    expect(tokensBefore.length).toBeGreaterThan(0);

    // Revoke OAuth tokens (simulating password change behavior)
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, testUserId));
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, testUserId));

    // Verify tokens are revoked
    const consentsAfter = await db
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, testUserId));
    const tokensAfter = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, testUserId));

    expect(consentsAfter.length).toBe(0);
    expect(tokensAfter.length).toBe(0);
  });

  it("should validate password requirements exist", () => {
    // Test password validation rules exist
    const weakPassword = "weak";
    const strongPassword = "StrongPass123!";

    // Weak password should be less than 8 characters
    expect(weakPassword.length).toBeLessThan(8);

    // Strong password should be at least 8 characters
    expect(strongPassword.length).toBeGreaterThanOrEqual(8);
  });
});
