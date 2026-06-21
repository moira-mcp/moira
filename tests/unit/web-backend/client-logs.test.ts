/**
 * Unit tests for Client Logs API endpoint
 * Tests HTTP request/response validation without mocking internal logger
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import express, { Application } from "express";
import request from "supertest";

// Import route directly - backendLog calls work, we just test HTTP behavior
import clientLogsRoutes from "../../../packages/web-backend/src/routes/client-logs.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

describe("Client Logs API", () => {
  let app: Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/logs/client", clientLogsRoutes);
    // Add error middleware to handle thrown AppErrors (must be registered AFTER routes)
    app.use(setupErrorMiddleware());
  });

  describe("POST /api/logs/client", () => {
    it("should accept valid error log and return success", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "Test error message",
        stack: "Error: Test\n    at test.js:1:1",
        url: "https://example.com/page",
        userAgent: "TestBrowser/1.0",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept valid warn log", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "warn",
        message: "Test warning",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept valid info log", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "info",
        message: "Test info",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept valid debug log", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "debug",
        message: "Test debug",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept log with metadata", async () => {
      const response = await request(app)
        .post("/api/logs/client")
        .send({
          level: "error",
          message: "Error with metadata",
          metadata: {
            componentName: "TestComponent",
            userId: "user123",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept log with timestamp", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "info",
        message: "Test with timestamp",
        timestamp: "2024-01-15T10:30:00.000Z",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should reject invalid level", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "invalid",
        message: "Test message",
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject empty message", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "",
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject missing level", async () => {
      const response = await request(app).post("/api/logs/client").send({
        message: "Test message",
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject missing message", async () => {
      const response = await request(app).post("/api/logs/client").send({
        level: "error",
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });
  });

  describe("POST /api/logs/client/batch", () => {
    it("should accept valid batch of logs", async () => {
      const response = await request(app)
        .post("/api/logs/client/batch")
        .send([
          { level: "error", message: "Error 1" },
          { level: "warn", message: "Warning 1" },
          { level: "info", message: "Info 1" },
        ]);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, processed: 3 });
    });

    it("should accept batch with all log levels", async () => {
      const response = await request(app)
        .post("/api/logs/client/batch")
        .send([
          { level: "error", message: "Error" },
          { level: "warn", message: "Warn" },
          { level: "info", message: "Info" },
          { level: "debug", message: "Debug" },
        ]);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, processed: 4 });
    });

    it("should reject batch with invalid entry", async () => {
      const response = await request(app)
        .post("/api/logs/client/batch")
        .send([
          { level: "error", message: "Valid" },
          { level: "invalid", message: "Invalid level" },
        ]);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid batch log entries");
    });

    it("should accept empty batch", async () => {
      const response = await request(app).post("/api/logs/client/batch").send([]);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, processed: 0 });
    });

    it("should reject batch exceeding max size (100)", async () => {
      const largeBatch = Array(101).fill({ level: "info", message: "Test" });

      const response = await request(app).post("/api/logs/client/batch").send(largeBatch);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid batch log entries");
    });

    it("should accept batch at max size (100)", async () => {
      const maxBatch = Array(100).fill({ level: "info", message: "Test" });

      const response = await request(app).post("/api/logs/client/batch").send(maxBatch);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, processed: 100 });
    });
  });

  describe("Input validation", () => {
    it("should reject message exceeding max length (10000)", async () => {
      const longMessage = "x".repeat(15000);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: longMessage,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject stack exceeding max length (50000)", async () => {
      const longStack = "x".repeat(60000);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "Error",
        stack: longStack,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject URL exceeding max length (2000)", async () => {
      const longUrl = "https://example.com/" + "x".repeat(2500);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "Error",
        url: longUrl,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should reject userAgent exceeding max length (1000)", async () => {
      const longUserAgent = "x".repeat(1500);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "Error",
        userAgent: longUserAgent,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe("Invalid log entry");
    });

    it("should accept message at max length (10000)", async () => {
      const maxMessage = "x".repeat(10000);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: maxMessage,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept stack at max length (50000)", async () => {
      const maxStack = "x".repeat(50000);

      const response = await request(app).post("/api/logs/client").send({
        level: "error",
        message: "Error",
        stack: maxStack,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should accept all optional fields", async () => {
      const response = await request(app)
        .post("/api/logs/client")
        .send({
          level: "error",
          message: "Full log entry",
          stack: "Error stack trace",
          url: "https://example.com/page",
          userAgent: "TestBrowser/1.0",
          timestamp: "2024-01-15T10:30:00.000Z",
          metadata: { extra: "data" },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });
  });
});
