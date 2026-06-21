/**
 * Static Artifact Serving E2E Tests
 * Tests public artifact serving via the Moira wrapper page (sandboxed iframe +
 * footer), the raw artifact frame, the first-visit interstitial, and the
 * security headers for both wrapper and frame.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// The /__frame route only serves content to iframe requests; top-level requests
// redirect to the wrapper (anti-phishing). Simulate an iframe load.
const IFRAME_FETCH = { headers: { "Sec-Fetch-Dest": "iframe" } } as const;

// Artifacts are served in subdomain-isolation mode: each artifact has its own
// origin {uuid}.static.<domain>. The upload response returns that origin; Node
// resolves *.localhost to loopback so the dev container is reachable there.
function originFromUrl(url: string): string {
  return url.replace(/\/$/, "");
}

// Build a sibling artifact origin by swapping the uuid label on the same
// host/port as a known-good origin. Keeps the domain/port driven by env
// (STATIC_ARTIFACTS_DOMAIN) instead of hardcoding a worktree-specific port.
function originForLabel(knownOrigin: string, label: string): string {
  const u = new URL(knownOrigin.endsWith("/") ? knownOrigin : `${knownOrigin}/`);
  const rest = u.hostname.slice(u.hostname.indexOf(".")); // ".static.localhost"
  return `${u.protocol}//${label}${rest}${u.port ? `:${u.port}` : ""}/`;
}

describe("Static Artifact Serving E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testArtifactUuid: string;
  let testArtifactOrigin: string;
  const createdUuids: string[] = [];

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Create a test artifact for serving tests
    const result = await callMCPTool(client, "artifacts", {
      action: "upload",
      name: "static-test.html",
      content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Static Test Artifact</title>
</head>
<body>
  <h1>Test Artifact Content</h1>
  <p>This is a test paragraph.</p>
</body>
</html>`,
    });
    testArtifactUuid = result.uuid;
    testArtifactOrigin = originFromUrl(result.url);
    createdUuids.push(testArtifactUuid);
  });

  afterAll(async () => {
    // Cleanup created artifacts
    for (const uuid of createdUuids) {
      try {
        await callMCPTool(client, "artifacts", { action: "delete", uuid });
      } catch {
        // Ignore cleanup errors
      }
    }
    await cleanup();
  });

  describe("Wrapper on the artifact subdomain (GET /)", () => {
    test("serves the wrapper with correct content type", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });

    test("shows interstitial on first visit (no iframe yet)", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);
      const html = await response.text();

      expect(html).toContain("User-generated content");
      expect(html).not.toMatch(/<iframe/);
      // Artifact content is NOT inlined into the wrapper
      expect(html).not.toContain("Test Artifact Content");
    });

    test("after ack, shows sandboxed iframe + Moira footer with Report", async () => {
      const response = await fetch(`${testArtifactOrigin}/?ack=1`);
      const html = await response.text();

      expect(html).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
      expect(html).toContain(`/__frame/${testArtifactUuid}`);
      expect(html).toContain("moira-branding-footer");
      expect(html).toContain("Created with");
      expect(html).toContain("moira-report-link");
      // Sandbox must NOT grant same-origin (so artifact JS can't reach wrapper)
      const iframeTag = html.match(/<iframe[\s\S]*?>/)?.[0] ?? "";
      expect(iframeTag).not.toContain("allow-same-origin");
    });

    test("wrapper CSP is strict (no scripts, frame DENY)", async () => {
      const response = await fetch(`${testArtifactOrigin}/?ack=1`);

      const csp = response.headers.get("content-security-policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-src 'self'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });

    test("sets X-Content-Type-Options header", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("sets Referrer-Policy header", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    });

    test("sets Cache-Control header", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      const cacheControl = response.headers.get("cache-control");
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("max-age=3600");
    });

    test("sets Last-Modified header", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      const lastModified = response.headers.get("last-modified");
      expect(lastModified).toBeDefined();
      const date = new Date(lastModified!);
      expect(date.getTime()).not.toBeNaN();
    });

    test("sets ETag header with uuid", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);

      const etag = response.headers.get("etag");
      expect(etag).toBeDefined();
      expect(etag).toContain(testArtifactUuid);
    });
  });

  describe("Wrapper localization (EN/RU)", () => {
    test("renders English by default / for an English Accept-Language", async () => {
      const response = await fetch(`${testArtifactOrigin}/`, {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("User-generated content");
      expect(html).toContain('<html lang="en">');
      // EN view offers a toggle to RU
      expect(html).toMatch(/class="moira-lang-toggle"[^>]*>RU</);
    });

    test("renders Russian for a Russian Accept-Language", async () => {
      const response = await fetch(`${testArtifactOrigin}/`, {
        headers: { "Accept-Language": "ru-RU,ru;q=0.9" },
      });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Контент создан пользователем");
      expect(html).toContain('<html lang="ru">');
      // RU view offers a toggle back to EN
      expect(html).toMatch(/class="moira-lang-toggle"[^>]*>EN</);
    });

    test("?lang= override beats Accept-Language", async () => {
      const response = await fetch(`${testArtifactOrigin}/?lang=ru`, {
        headers: { "Accept-Language": "en-US,en" },
      });
      const html = await response.text();

      expect(html).toContain("Контент создан пользователем");
      expect(html).toContain('<html lang="ru">');
    });

    test("footer (after ack) is localized with a toggle", async () => {
      const response = await fetch(`${testArtifactOrigin}/?ack=1`, {
        headers: { "Accept-Language": "ru-RU,ru" },
      });
      const html = await response.text();

      expect(html).toContain("Создано с"); // "Created with" (RU)
      expect(html).toContain("Пожаловаться"); // "Report" (RU)
      expect(html).toContain("moira-lang-toggle");
    });

    test("sets Vary so caches do not cross languages", async () => {
      const response = await fetch(`${testArtifactOrigin}/`);
      const vary = response.headers.get("vary") ?? "";

      expect(vary).toContain("Accept-Language");
      expect(vary).toContain("Cookie");
    });
  });

  describe("GET /static/__frame/:uuid (artifact content)", () => {
    test("serves raw artifact content (no footer in frame)", async () => {
      const response = await fetch(
        `${testArtifactOrigin}/__frame/${testArtifactUuid}`,
        IFRAME_FETCH,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Test Artifact Content");
      expect(html).toContain("This is a test paragraph.");
      // Footer must NOT be in the artifact document (two-document split)
      expect(html).not.toContain("Created with Moira");
      expect(html).not.toContain("moira-branding-footer");
    });

    test("frame CSP allows scripts but blocks network", async () => {
      const response = await fetch(
        `${testArtifactOrigin}/__frame/${testArtifactUuid}`,
        IFRAME_FETCH,
      );

      const csp = response.headers.get("content-security-policy");
      expect(csp).toBeDefined();
      expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("form-action 'none'");
    });

    test("top-level navigation to the frame redirects to the wrapper (anti-phishing)", async () => {
      const response = await fetch(`${testArtifactOrigin}/__frame/${testArtifactUuid}`, {
        headers: { "Sec-Fetch-Dest": "document" },
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      // On the artifact subdomain the wrapper is at "/"
      expect(response.headers.get("location")).toBe("/");
    });
  });

  describe("404 handling", () => {
    test("returns 404 for non-existent artifact (on its subdomain)", async () => {
      const fakeUuid = "00000000-0000-0000-0000-000000000000";
      const response = await fetch(originForLabel(testArtifactOrigin, fakeUuid));

      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Artifact Not Found");
      expect(html).toContain("Moira"); // 404 page also branded
    });

    test("returns 404 for invalid UUID format (on its subdomain)", async () => {
      const response = await fetch(originForLabel(testArtifactOrigin, "invaliduuid"));
      expect(response.status).toBe(404);
    });

    test("returns 404 for deleted artifact", async () => {
      // Create an artifact
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "to-delete.html",
        content: "<html><body>Will be deleted</body></html>",
      });
      const uuid = result.uuid;
      const origin = originFromUrl(result.url);

      // Verify it's accessible on its subdomain
      const beforeDelete = await fetch(`${origin}/?ack=1`);
      expect(beforeDelete.status).toBe(200);

      // Delete it
      await callMCPTool(client, "artifacts", { action: "delete", uuid });

      // Should now return 404
      const afterDelete = await fetch(`${origin}/?ack=1`);
      expect(afterDelete.status).toBe(404);
    });
  });

  describe("Content handling (frame serves content as-is)", () => {
    test("handles HTML without body tag", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "no-body.html",
        content: "<html><h1>No body tag</h1></html>",
      });
      createdUuids.push(result.uuid);

      const response = await fetch(
        `${originFromUrl(result.url)}/__frame/${result.uuid}`,
        IFRAME_FETCH,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("No body tag");
      // Content served verbatim — no branding injected into the artifact document
      expect(html).not.toContain("moira-branding-footer");
    });

    test("handles minimal HTML", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "minimal.html",
        content: "<p>Just a paragraph</p>",
      });
      createdUuids.push(result.uuid);

      const response = await fetch(
        `${originFromUrl(result.url)}/__frame/${result.uuid}`,
        IFRAME_FETCH,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Just a paragraph");
      expect(html).not.toContain("moira-branding-footer");
    });

    test("preserves Unicode content", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "unicode.html",
        content: "<html><body><h1>Unicode Test</h1><p>Привет мир! こんにちは 🌍</p></body></html>",
      });
      createdUuids.push(result.uuid);

      const response = await fetch(
        `${originFromUrl(result.url)}/__frame/${result.uuid}`,
        IFRAME_FETCH,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Привет мир!");
      expect(html).toContain("こんにちは");
      expect(html).toContain("🌍");
    });
  });

  describe("Public access", () => {
    test("artifact wrapper is accessible without authentication", async () => {
      const response = await fetch(`${testArtifactOrigin}/?ack=1`, {
        credentials: "omit",
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      // Wrapper references the artifact frame; content itself is served via frame
      expect(html).toContain(`/__frame/${testArtifactUuid}`);
    });

    test("artifact frame content is accessible without authentication", async () => {
      const response = await fetch(`${testArtifactOrigin}/__frame/${testArtifactUuid}`, {
        credentials: "omit",
        headers: { "Sec-Fetch-Dest": "iframe" },
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Artifact Content");
    });
  });
});
