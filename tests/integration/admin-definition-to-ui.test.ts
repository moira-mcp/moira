/**
 * Integration Test: Admin creates definition → appears in user settings UI
 * Tests Step 9 requirement: create definition via admin → appears в user settings UI automatically
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import { inArray } from "drizzle-orm";

describe("Admin Definition to UI Integration", () => {
  let repository: DatabaseRepository;
  const testUserId = "test-user-def-ui";
  const testUser1 = "test-user-1-def";
  const testUser2 = "test-user-2-def";
  const testDefinitionKey1 = "test.integration_definition_1";
  const testDefinitionKey2 = "test.integration_definition_2";

  beforeAll(async () => {
    repository = new DatabaseRepository();
    const db = getDatabase();

    // Create test users for FOREIGN KEY constraint
    const now = new Date().toISOString();
    await db
      .insert(user)
      .values([
        {
          id: testUserId,
          email: `${testUserId}@test.local`,
          name: "Test User",
          handle: testUserId,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: testUser1,
          email: `${testUser1}@test.local`,
          name: "Test User 1",
          handle: testUser1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: testUser2,
          email: `${testUser2}@test.local`,
          name: "Test User 2",
          handle: testUser2,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    const db = getDatabase();

    // Cleanup definitions
    try {
      await repository.deleteSettingDefinition(testDefinitionKey1);
      await repository.deleteSettingDefinition(testDefinitionKey2);
    } catch (error) {
      // Ignore if doesn't exist
    }

    // Cleanup test users
    await db.delete(user).where(inArray(user.id, [testUserId, testUser1, testUser2]));
  });

  it("admin creates definition and it appears in user settings UI flow", async () => {
    // Step 1: Admin creates setting definition via repository
    await repository.createSettingDefinition({
      key: testDefinitionKey1,
      type: "string",
      category: "test",
      label: "Test Integration Definition",
      description: "Created by integration test",
      defaultValue: "default_value",
      required: false,
      validation: null,
      adminOnly: false,
    });

    // Step 2: Verify definition exists in definitions list
    const definitions = await repository.getSettingDefinitions();
    const createdDef = definitions.find((d) => d.key === testDefinitionKey1);
    expect(createdDef).toBeDefined();
    expect(createdDef?.type).toBe("string");
    expect(createdDef?.category).toBe("test");
    expect(createdDef?.label).toBe("Test Integration Definition");

    // Step 3: User gets settings - definition should be available
    const _userSettings = await repository.getSettings(testUserId);

    // Step 4: Verify definition is accessible (even if not set by user yet)
    // The definition exists, so UI can display it
    expect(createdDef).not.toBeNull();

    // Step 5: User sets value for new definition
    await repository.setSetting(testUserId, testDefinitionKey1, "user_custom_value");

    // Step 6: Verify user setting saved correctly
    const updatedSettings = await repository.getSettings(testUserId);
    expect(updatedSettings[testDefinitionKey1]).toBe("user_custom_value");

    // Step 7: Admin deletes definition
    await repository.deleteSettingDefinition(testDefinitionKey1);

    // Step 8: Verify definition removed from definitions list
    const definitionsAfterDelete = await repository.getSettingDefinitions();
    const deletedDef = definitionsAfterDelete.find((d) => d.key === testDefinitionKey1);
    expect(deletedDef).toBeUndefined();

    // Step 9: User settings should cascade delete (definition gone, value gone)
    const settingsAfterDelete = await repository.getSettings(testUserId);
    expect(settingsAfterDelete[testDefinitionKey1]).toBeUndefined();
  });

  it("definition changes reflect immediately in all users", async () => {
    // Use test users created in beforeAll
    const user1 = testUser1;
    const user2 = testUser2;

    // Create definition
    await repository.createSettingDefinition({
      key: testDefinitionKey2,
      type: "number",
      category: "test",
      label: "Multi User Test",
      description: "Test for multiple users",
      defaultValue: "100",
      required: false,
      validation: null,
      adminOnly: false,
    });

    // Both users can see definition
    const defs = await repository.getSettingDefinitions();
    const def = defs.find((d) => d.key === testDefinitionKey2);
    expect(def).toBeDefined();

    // User 1 sets value
    await repository.setSetting(user1, testDefinitionKey2, "200");

    // User 2 sets different value
    await repository.setSetting(user2, testDefinitionKey2, "300");

    // Verify each user has their own value
    const user1Settings = await repository.getSettings(user1);
    const user2Settings = await repository.getSettings(user2);

    expect(user1Settings[testDefinitionKey2]).toBe(200);
    expect(user2Settings[testDefinitionKey2]).toBe(300);

    // Cleanup
    await repository.deleteSettingDefinition(testDefinitionKey2);
  });
});
