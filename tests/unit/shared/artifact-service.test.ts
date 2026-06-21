/**
 * Unit tests for ArtifactService
 * Tests validation, quota enforcement, token management, and audit logging
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { ArtifactRepository } from "../../../packages/shared/src/database/repositories/artifact-repository.js";
import { AuditRepository } from "../../../packages/shared/src/database/repositories/audit-repository.js";
import {
  ArtifactService,
  ArtifactNotFoundError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  ArtifactAccessDeniedError,
  InvalidArtifactContentError,
  InvalidArtifactTokenError,
  validateHtmlContent,
  validateArtifactName,
  MAX_ARTIFACT_SIZE,
  MAX_ARTIFACT_TOTAL_SIZE,
  MAX_ARTIFACTS_PER_USER,
  AuditAction,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const TEST_USER_ID = "test-user-artifact-123";
const TEST_USER_ID_2 = "test-user-artifact-456";
const TEST_EXECUTION_ID = "test-execution-123";

// Sample HTML content for testing
const VALID_HTML =
  "<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>";
const VALID_HTML_SIMPLE = "<html><body><p>Test</p></body></html>";
const INVALID_CONTENT = "This is just plain text without HTML tags";

describe("ArtifactService", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let artifactRepo: ArtifactRepository;
  let auditRepo: AuditRepository;
  let artifactService: ArtifactService;

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations to create tables
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    // Create test users
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values([
        {
          id: TEST_USER_ID,
          email: "artifact-test@example.com",
          name: "Artifact Test User",
          handle: "artifact-test-user",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: TEST_USER_ID_2,
          email: "artifact-test2@example.com",
          name: "Artifact Test User 2",
          handle: "artifact-test-user-2",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    // Create test workflow execution for linking tests
    db.insert(schema.workflow)
      .values({
        id: "test-workflow-123",
        userId: TEST_USER_ID,
        slug: "test-workflow",
        name: "Test Workflow",
        version: "1.0.0",
        graph: "{}",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    db.insert(schema.workflowExecution)
      .values({
        executionId: TEST_EXECUTION_ID,
        workflowId: "test-workflow-123",
        userId: TEST_USER_ID,
        state: "completed",
        context: "{}",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    artifactRepo = new ArtifactRepository(db);
    auditRepo = new AuditRepository(db);
    artifactService = new ArtifactService(artifactRepo, auditRepo);
  });

  afterEach(() => {
    sqlite?.close();
  });

  // ===== Validation Function Tests =====

  describe("validateHtmlContent", () => {
    it("accepts valid HTML with doctype", () => {
      expect(validateHtmlContent(VALID_HTML).valid).toBe(true);
    });

    it("accepts valid HTML without doctype", () => {
      expect(validateHtmlContent(VALID_HTML_SIMPLE).valid).toBe(true);
    });

    it("accepts HTML with just body tag", () => {
      expect(validateHtmlContent("<body><p>Test</p></body>").valid).toBe(true);
    });

    it("accepts HTML with any HTML tag", () => {
      expect(validateHtmlContent("<div>Content</div>").valid).toBe(true);
      expect(validateHtmlContent("<p>Paragraph</p>").valid).toBe(true);
    });

    it("rejects empty content", () => {
      const result = validateHtmlContent("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects whitespace only", () => {
      const result = validateHtmlContent("   ");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("rejects plain text without HTML", () => {
      const result = validateHtmlContent(INVALID_CONTENT);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTML");
    });
  });

  describe("validateArtifactName", () => {
    it("accepts valid names", () => {
      expect(validateArtifactName("My Report").valid).toBe(true);
      expect(validateArtifactName("report_2024-01.html").valid).toBe(true);
      expect(validateArtifactName("a").valid).toBe(true);
    });

    it("rejects empty name", () => {
      const result = validateArtifactName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects name exceeding max length", () => {
      const result = validateArtifactName("a".repeat(256));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("255");
    });
  });

  // ===== Create Tests =====

  describe("create", () => {
    it("creates artifact with audit log", async () => {
      const result = await artifactService.create(TEST_USER_ID, {
        name: "Test Report",
        content: VALID_HTML,
      });

      expect(result.uuid).toBeDefined();
      expect(result.name).toBe("Test Report");
      expect(result.size).toBeGreaterThan(0);
      expect(result.mimeType).toBe("text/html");
      expect(result.expiresAt).toBeGreaterThan(Date.now());

      // Verify audit log
      const auditLogs = await auditRepo.list({ action: AuditAction.ARTIFACT_CREATE });
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].resourceId).toBe(result.uuid);
    });

    it("creates artifact with execution link", async () => {
      const result = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
        executionId: TEST_EXECUTION_ID,
      });

      expect(result.executionId).toBe(TEST_EXECUTION_ID);
    });

    it("throws InvalidArtifactContentError for invalid name", async () => {
      await expect(
        artifactService.create(TEST_USER_ID, {
          name: "",
          content: VALID_HTML,
        }),
      ).rejects.toThrow(InvalidArtifactContentError);
    });

    it("throws InvalidArtifactContentError for invalid HTML", async () => {
      await expect(
        artifactService.create(TEST_USER_ID, {
          name: "Test",
          content: INVALID_CONTENT,
        }),
      ).rejects.toThrow(InvalidArtifactContentError);
    });

    it("throws ArtifactSizeExceededError for oversized content", async () => {
      const bigContent =
        "<!DOCTYPE html><html><body>" + "x".repeat(MAX_ARTIFACT_SIZE) + "</body></html>";
      await expect(
        artifactService.create(TEST_USER_ID, {
          name: "Big Report",
          content: bigContent,
        }),
      ).rejects.toThrow(ArtifactSizeExceededError);
    });

    it("throws ArtifactQuotaExceededError for storage quota", async () => {
      // Create artifacts to fill quota (using smaller quota for test)
      const smallService = new ArtifactService(artifactRepo, auditRepo, {
        maxTotalSize: 1000, // 1KB limit
      });

      await smallService.create(TEST_USER_ID, {
        name: "Report 1",
        content: "<html><body>" + "x".repeat(400) + "</body></html>",
      });

      await expect(
        smallService.create(TEST_USER_ID, {
          name: "Report 2",
          content: "<html><body>" + "x".repeat(800) + "</body></html>",
        }),
      ).rejects.toThrow(ArtifactQuotaExceededError);
    });

    it("throws ArtifactQuotaExceededError for count quota", async () => {
      // Use small count limit for test
      const smallService = new ArtifactService(artifactRepo, auditRepo, {
        maxCount: 2,
      });

      await smallService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await smallService.create(TEST_USER_ID, { name: "R2", content: VALID_HTML });

      await expect(
        smallService.create(TEST_USER_ID, { name: "R3", content: VALID_HTML }),
      ).rejects.toThrow(ArtifactQuotaExceededError);
    });
  });

  // ===== Get Tests =====

  describe("get", () => {
    it("returns artifact by UUID", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      const artifact = await artifactService.get(TEST_USER_ID, created.uuid);
      expect(artifact.uuid).toBe(created.uuid);
      expect(artifact.name).toBe("Report");
      expect(artifact.content).toBe(VALID_HTML);
    });

    it("throws ArtifactNotFoundError for missing UUID", async () => {
      await expect(artifactService.get(TEST_USER_ID, "non-existent")).rejects.toThrow(
        ArtifactNotFoundError,
      );
    });

    it("throws ArtifactNotFoundError for other user's artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await expect(artifactService.get(TEST_USER_ID_2, created.uuid)).rejects.toThrow(
        ArtifactNotFoundError,
      );
    });
  });

  describe("getOrNull", () => {
    it("returns null for missing UUID", async () => {
      const artifact = await artifactService.getOrNull(TEST_USER_ID, "non-existent");
      expect(artifact).toBeNull();
    });
  });

  describe("getPublic", () => {
    it("returns artifact for public serving", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Public Report",
        content: VALID_HTML,
      });

      const artifact = await artifactService.getPublic(created.uuid);
      expect(artifact).not.toBeNull();
      expect(artifact!.uuid).toBe(created.uuid);
      expect(artifact!.content).toBe(VALID_HTML);
    });

    it("returns null for deleted artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await artifactService.delete(TEST_USER_ID, created.uuid);

      const artifact = await artifactService.getPublic(created.uuid);
      expect(artifact).toBeNull();
    });
  });

  // ===== List Tests =====

  describe("list", () => {
    it("lists user artifacts", async () => {
      await artifactService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID, { name: "R2", content: VALID_HTML });

      const result = await artifactService.list(TEST_USER_ID);
      expect(result.total).toBe(2);
      expect(result.artifacts.length).toBe(2);
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await artifactService.create(TEST_USER_ID, { name: `R${i}`, content: VALID_HTML });
      }

      const page1 = await artifactService.list(TEST_USER_ID, { limit: 2, offset: 0 });
      expect(page1.artifacts.length).toBe(2);
      expect(page1.total).toBe(5);

      const page2 = await artifactService.list(TEST_USER_ID, { limit: 2, offset: 2 });
      expect(page2.artifacts.length).toBe(2);
    });

    it("excludes deleted artifacts", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "R1",
        content: VALID_HTML,
      });
      await artifactService.create(TEST_USER_ID, { name: "R2", content: VALID_HTML });
      await artifactService.delete(TEST_USER_ID, created.uuid);

      const result = await artifactService.list(TEST_USER_ID);
      expect(result.total).toBe(1);
    });
  });

  // ===== Update Tests =====

  describe("update", () => {
    it("updates artifact content", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      const newContent = "<html><body><h2>Updated</h2></body></html>";
      await artifactService.update(TEST_USER_ID, created.uuid, { content: newContent });

      const updated = await artifactService.get(TEST_USER_ID, created.uuid);
      expect(updated.content).toBe(newContent);

      // Verify audit log
      const auditLogs = await auditRepo.list({ action: AuditAction.ARTIFACT_UPDATE });
      expect(auditLogs.length).toBe(1);
    });

    it("updates artifact name", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Old Name",
        content: VALID_HTML,
      });

      await artifactService.update(TEST_USER_ID, created.uuid, {
        content: VALID_HTML,
        name: "New Name",
      });

      const updated = await artifactService.get(TEST_USER_ID, created.uuid);
      expect(updated.name).toBe("New Name");
    });

    it("throws ArtifactNotFoundError for missing artifact", async () => {
      await expect(
        artifactService.update(TEST_USER_ID, "non-existent", { content: VALID_HTML }),
      ).rejects.toThrow(ArtifactNotFoundError);
    });

    it("throws ArtifactAccessDeniedError for other user's artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await expect(
        artifactService.update(TEST_USER_ID_2, created.uuid, { content: VALID_HTML }),
      ).rejects.toThrow(ArtifactAccessDeniedError);
    });

    it("throws InvalidArtifactContentError for invalid HTML", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await expect(
        artifactService.update(TEST_USER_ID, created.uuid, { content: INVALID_CONTENT }),
      ).rejects.toThrow(InvalidArtifactContentError);
    });

    it("allows update within quota", async () => {
      // Use small quota
      const smallService = new ArtifactService(artifactRepo, auditRepo, {
        maxTotalSize: 2000,
      });

      const created = await smallService.create(TEST_USER_ID, {
        name: "Report",
        content: "<html><body>" + "x".repeat(500) + "</body></html>",
      });

      // Update with similar size should work
      await expect(
        smallService.update(TEST_USER_ID, created.uuid, {
          content: "<html><body>" + "y".repeat(500) + "</body></html>",
        }),
      ).resolves.not.toThrow();
    });
  });

  // ===== Delete Tests =====

  describe("delete", () => {
    it("soft deletes artifact with audit log", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await artifactService.delete(TEST_USER_ID, created.uuid);

      // Should not be accessible
      await expect(artifactService.get(TEST_USER_ID, created.uuid)).rejects.toThrow(
        ArtifactNotFoundError,
      );

      // Verify audit log
      const auditLogs = await auditRepo.list({ action: AuditAction.ARTIFACT_DELETE });
      expect(auditLogs.length).toBe(1);
    });

    it("throws ArtifactNotFoundError for missing artifact", async () => {
      await expect(artifactService.delete(TEST_USER_ID, "non-existent")).rejects.toThrow(
        ArtifactNotFoundError,
      );
    });

    it("throws ArtifactAccessDeniedError for other user's artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await expect(artifactService.delete(TEST_USER_ID_2, created.uuid)).rejects.toThrow(
        ArtifactAccessDeniedError,
      );
    });
  });

  // ===== Stats Tests =====

  describe("getStats", () => {
    it("returns user statistics", async () => {
      await artifactService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID, { name: "R2", content: VALID_HTML });

      const stats = await artifactService.getStats(TEST_USER_ID);
      expect(stats.totalArtifacts).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.storageLimit).toBe(MAX_ARTIFACT_TOTAL_SIZE);
      expect(stats.countLimit).toBe(MAX_ARTIFACTS_PER_USER);
      expect(stats.storageUsedPercent).toBeLessThan(1);
      expect(stats.countUsedPercent).toBe(4); // 2/50 = 4%
    });
  });

  // ===== Token Tests =====

  describe("createUploadToken", () => {
    it("creates upload token", async () => {
      const token = await artifactService.createUploadToken(TEST_USER_ID);
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");

      // Verify audit log
      const auditLogs = await auditRepo.list({ action: AuditAction.ARTIFACT_TOKEN_CREATE });
      expect(auditLogs.length).toBe(1);
    });
  });

  describe("validateToken", () => {
    it("validates valid token", async () => {
      const token = await artifactService.createUploadToken(TEST_USER_ID);
      const result = await artifactService.validateToken(token);
      expect(result.userId).toBe(TEST_USER_ID);
    });

    it("throws InvalidArtifactTokenError for invalid token", async () => {
      await expect(artifactService.validateToken("invalid-token")).rejects.toThrow(
        InvalidArtifactTokenError,
      );
    });
  });

  describe("createWithToken", () => {
    it("creates artifact with token and marks token as used", async () => {
      const token = await artifactService.createUploadToken(TEST_USER_ID);

      const artifact = await artifactService.createWithToken(token, {
        name: "Token Upload",
        content: VALID_HTML,
      });

      expect(artifact.uuid).toBeDefined();
      expect(artifact.name).toBe("Token Upload");

      // Token should be marked as used - can't use again
      await expect(
        artifactService.createWithToken(token, {
          name: "Second Upload",
          content: VALID_HTML,
        }),
      ).rejects.toThrow(InvalidArtifactTokenError);
    });
  });

  // ===== User Isolation Tests =====

  describe("user isolation", () => {
    it("cannot access other user's artifacts", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Secret",
        content: VALID_HTML,
      });

      await expect(artifactService.get(TEST_USER_ID_2, created.uuid)).rejects.toThrow(
        ArtifactNotFoundError,
      );
    });

    it("list shows only own artifacts", async () => {
      await artifactService.create(TEST_USER_ID, { name: "User1 Report", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID_2, { name: "User2 Report", content: VALID_HTML });

      const result1 = await artifactService.list(TEST_USER_ID);
      expect(result1.total).toBe(1);
      expect(result1.artifacts[0].name).toBe("User1 Report");

      const result2 = await artifactService.list(TEST_USER_ID_2);
      expect(result2.total).toBe(1);
      expect(result2.artifacts[0].name).toBe("User2 Report");
    });

    it("quota is per-user", async () => {
      // Use small quota
      const smallService = new ArtifactService(artifactRepo, auditRepo, {
        maxCount: 1,
      });

      await smallService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });

      // First user can't create more
      await expect(
        smallService.create(TEST_USER_ID, { name: "R2", content: VALID_HTML }),
      ).rejects.toThrow(ArtifactQuotaExceededError);

      // Second user should still be able to create
      const result = await smallService.create(TEST_USER_ID_2, {
        name: "Other User",
        content: VALID_HTML,
      });
      expect(result.uuid).toBeDefined();
    });
  });

  // ===== Admin Tests =====

  describe("adminDelete", () => {
    it("admin can delete any user's artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await artifactService.adminDelete(TEST_USER_ID_2, created.uuid);

      // Should not be accessible
      await expect(artifactService.getPublic(created.uuid)).resolves.toBeNull();

      // Verify audit log
      const auditLogs = await auditRepo.list({ action: AuditAction.ADMIN_ARTIFACT_DELETE });
      expect(auditLogs.length).toBe(1);
    });

    it("throws ArtifactNotFoundError for missing artifact", async () => {
      await expect(artifactService.adminDelete(TEST_USER_ID, "non-existent")).rejects.toThrow(
        ArtifactNotFoundError,
      );
    });
  });

  describe("adminList", () => {
    it("lists all artifacts", async () => {
      await artifactService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID_2, { name: "R2", content: VALID_HTML });

      const result = await artifactService.adminList(TEST_USER_ID);
      expect(result.total).toBe(2);
      expect(result.artifacts.length).toBe(2);

      // Should include userId
      expect(result.artifacts.some((a) => a.userId === TEST_USER_ID)).toBe(true);
      expect(result.artifacts.some((a) => a.userId === TEST_USER_ID_2)).toBe(true);
    });

    it("filters by user", async () => {
      await artifactService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID_2, { name: "R2", content: VALID_HTML });

      const result = await artifactService.adminList(TEST_USER_ID, { userId: TEST_USER_ID_2 });
      expect(result.total).toBe(1);
      expect(result.artifacts[0].name).toBe("R2");
    });
  });

  describe("adminGetSystemStats", () => {
    it("returns system-wide statistics", async () => {
      await artifactService.create(TEST_USER_ID, { name: "R1", content: VALID_HTML });
      await artifactService.create(TEST_USER_ID_2, { name: "R2", content: VALID_HTML });

      const stats = await artifactService.adminGetSystemStats(TEST_USER_ID);
      expect(stats.totalArtifacts).toBe(2);
      expect(stats.totalUsers).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
    });
  });

  // ===== Utility Tests =====

  describe("isOwner", () => {
    it("returns true for owner", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      expect(await artifactService.isOwner(created.uuid, TEST_USER_ID)).toBe(true);
    });

    it("returns false for non-owner", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      expect(await artifactService.isOwner(created.uuid, TEST_USER_ID_2)).toBe(false);
    });
  });

  describe("exists", () => {
    it("returns true for existing artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      expect(await artifactService.exists(created.uuid)).toBe(true);
    });

    it("returns false for deleted artifact", async () => {
      const created = await artifactService.create(TEST_USER_ID, {
        name: "Report",
        content: VALID_HTML,
      });

      await artifactService.delete(TEST_USER_ID, created.uuid);
      expect(await artifactService.exists(created.uuid)).toBe(false);
    });
  });
});
