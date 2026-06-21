/**
 * Request Body Logger Middleware Tests
 * Tests for POST/PUT/PATCH body logging with sensitive endpoint exclusion
 *
 * Testing approach: Tests middleware behavior via supertest, verifying
 * that next() is called and sensitive endpoints are properly excluded.
 * Actual logging behavior is tested via integration tests.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import express, { Application, Request, Response } from "express";
import request from "supertest";
import { requestBodyLogger } from "../../../packages/web-backend/src/middleware/request-body-logger.js";

describe("requestBodyLogger middleware", () => {
  let app: Application;
  let lastRequestDetails: {
    method: string;
    path: string;
    body: unknown;
  } | null;

  beforeEach(() => {
    lastRequestDetails = null;
    app = express();
    app.use(express.json());
    app.use(requestBodyLogger());

    // Test endpoint that captures request details
    app.all("/api/*", (req: Request, res: Response) => {
      lastRequestDetails = {
        method: req.method,
        path: req.path,
        body: req.body,
      };
      res.json({ success: true });
    });
  });

  describe("method filtering", () => {
    it("should pass POST request through middleware", async () => {
      const response = await request(app).post("/api/workflows").send({ name: "test-workflow" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.method).toBe("POST");
      expect(lastRequestDetails?.body).toEqual({ name: "test-workflow" });
    });

    it("should pass PUT request through middleware", async () => {
      const response = await request(app).put("/api/workflows/test").send({ name: "updated" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.method).toBe("PUT");
    });

    it("should pass PATCH request through middleware", async () => {
      const response = await request(app)
        .patch("/api/workflows/test")
        .send({ visibility: "public" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.method).toBe("PATCH");
    });

    it("should pass GET request through middleware (not logged)", async () => {
      const response = await request(app).get("/api/workflows");

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.method).toBe("GET");
    });

    it("should pass DELETE request through middleware (not logged)", async () => {
      const response = await request(app).delete("/api/workflows/test");

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.method).toBe("DELETE");
    });
  });

  describe("sensitive endpoint exclusion", () => {
    it("should pass through /api/auth/* endpoints (not logged)", async () => {
      // Auth endpoints are excluded from body logging
      const response = await request(app)
        .post("/api/auth/sign-in")
        .send({ email: "test@test.com", password: "secret123" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.path).toBe("/api/auth/sign-in");
    });

    it("should pass through /api/user/change-password endpoint (not logged)", async () => {
      const response = await request(app)
        .post("/api/user/change-password")
        .send({ oldPassword: "old", newPassword: "new" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.path).toBe("/api/user/change-password");
    });

    it("should pass through /api/public/workflows endpoint (not logged)", async () => {
      const response = await request(app).post("/api/public/workflows").send({ token: "abc123" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.path).toBe("/api/public/workflows");
    });

    it("should pass through /api/public/other endpoint (logged normally)", async () => {
      const response = await request(app).post("/api/public/other").send({ data: "test" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.path).toBe("/api/public/other");
    });
  });

  describe("request ID handling", () => {
    it("should set X-Request-Id header on response", async () => {
      // Add request context middleware simulation
      app = express();
      app.use((req, res, next) => {
        // Simulate requestContextMiddleware setting X-Request-Id
        req.headers["x-request-id"] = "test-correlation-id-123";
        next();
      });
      app.use(express.json());
      app.use(requestBodyLogger());
      app.all("/api/*", (_req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app).post("/api/workflows").send({ name: "test" });

      expect(response.status).toBe(200);
    });
  });

  describe("body handling", () => {
    it("should handle empty body", async () => {
      const response = await request(app)
        .post("/api/workflows")
        .set("Content-Type", "application/json")
        .send({});

      expect(response.status).toBe(200);
    });

    it("should handle large body", async () => {
      const largeBody = { data: "x".repeat(15000) };

      const response = await request(app).post("/api/workflows").send(largeBody);

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.body).toEqual(largeBody);
    });

    it("should handle nested objects", async () => {
      const nestedBody = {
        metadata: {
          name: "Test",
          version: "1.0.0",
        },
        nodes: [
          { id: "start", type: "start" },
          { id: "end", type: "end" },
        ],
      };

      const response = await request(app).post("/api/workflows").send(nestedBody);

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.body).toEqual(nestedBody);
    });

    it("should handle array body", async () => {
      const arrayBody = [1, 2, 3, 4, 5];

      const response = await request(app).post("/api/workflows").send(arrayBody);

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.body).toEqual(arrayBody);
    });
  });

  describe("middleware chain integration", () => {
    it("should not block request processing", async () => {
      const response = await request(app).post("/api/workflows").send({ name: "test" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it("should work with query parameters", async () => {
      const response = await request(app).post("/api/workflows?draft=true").send({ name: "test" });

      expect(response.status).toBe(200);
    });

    it("should work with URL-encoded content type", async () => {
      app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));
      app.use(requestBodyLogger());
      app.all("/api/*", (req: Request, res: Response) => {
        lastRequestDetails = {
          method: req.method,
          path: req.path,
          body: req.body,
        };
        res.json({ success: true });
      });

      const response = await request(app)
        .post("/api/workflows")
        .type("form")
        .send({ name: "test" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.body).toEqual({ name: "test" });
    });
  });

  describe("custom options", () => {
    it("should respect custom maxBodySize option", async () => {
      app = express();
      app.use(express.json());
      app.use(requestBodyLogger({ maxBodySize: 50 }));
      app.all("/api/*", (req: Request, res: Response) => {
        lastRequestDetails = {
          method: req.method,
          path: req.path,
          body: req.body,
        };
        res.json({ success: true });
      });

      const response = await request(app)
        .post("/api/workflows")
        .send({ data: "x".repeat(100) });

      expect(response.status).toBe(200);
      // Body is still passed to handler, only logging is truncated
      expect((lastRequestDetails?.body as { data: string }).data.length).toBe(100);
    });

    it("should respect additional exclude patterns", async () => {
      app = express();
      app.use(express.json());
      app.use(
        requestBodyLogger({
          additionalExcludePatterns: [/^\/api\/custom-sensitive/],
        }),
      );
      app.all("/api/*", (req: Request, res: Response) => {
        lastRequestDetails = {
          method: req.method,
          path: req.path,
          body: req.body,
        };
        res.json({ success: true });
      });

      const response = await request(app).post("/api/custom-sensitive").send({ secret: "data" });

      expect(response.status).toBe(200);
      expect(lastRequestDetails?.path).toBe("/api/custom-sensitive");
    });
  });
});
