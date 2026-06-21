/**
 * Unit Tests - Workflow Privacy Defaults
 * Verify database schema defaults visibility to private
 */

import { describe, test, expect } from "@jest/globals";
import { getSqliteInstance } from "@mcp-moira/shared";

describe("Workflow Privacy Defaults - Database Schema", () => {
  const testUserId = "system-admin";

  test("database schema defaults visibility to private", () => {
    const workflowId = `test-schema-default-${Date.now()}`;
    const slug = `test-schema-default-${Date.now()}`;
    const db = getSqliteInstance();

    // Insert workflow WITHOUT specifying visibility
    const insertStmt = db.prepare(`
      INSERT INTO workflow (id, userId, slug, name, version, graph, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      workflowId,
      testUserId,
      slug,
      "Schema Default Test",
      "1.0.0",
      JSON.stringify({ nodes: [] }),
      Date.now(),
      Date.now(),
    );

    // Query visibility
    const selectStmt = db.prepare("SELECT visibility FROM workflow WHERE id = ?");
    const result = selectStmt.get(workflowId) as any;

    expect(result?.visibility).toBe("private");

    // Cleanup
    const deleteStmt = db.prepare("DELETE FROM workflow WHERE id = ?");
    deleteStmt.run(workflowId);
  });

  test("database schema accepts explicit visibility values", () => {
    const publicId = `test-schema-public-${Date.now()}`;
    const privateId = `test-schema-private-${Date.now()}`;
    const publicSlug = `test-schema-public-${Date.now()}`;
    const privateSlug = `test-schema-private-${Date.now()}`;
    const db = getSqliteInstance();

    const insertStmt = db.prepare(`
      INSERT INTO workflow (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert public workflow
    insertStmt.run(
      publicId,
      testUserId,
      publicSlug,
      "Public",
      "1.0.0",
      "{}",
      "public",
      Date.now(),
      Date.now(),
    );

    // Insert private workflow
    insertStmt.run(
      privateId,
      testUserId,
      privateSlug,
      "Private",
      "1.0.0",
      "{}",
      "private",
      Date.now(),
      Date.now(),
    );

    const selectStmt = db.prepare("SELECT visibility FROM workflow WHERE id = ?");
    const publicResult = selectStmt.get(publicId) as any;
    const privateResult = selectStmt.get(privateId) as any;

    expect(publicResult?.visibility).toBe("public");
    expect(privateResult?.visibility).toBe("private");

    // Cleanup
    const deleteStmt = db.prepare("DELETE FROM workflow WHERE id IN (?, ?)");
    deleteStmt.run(publicId, privateId);
  });
});
