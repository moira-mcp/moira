import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestFetchUrl();
const MIB = 1024 * 1024;

describe("artifact size policy through packaged ingress", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let closeClient: (() => Promise<void>) | undefined;
  let cookie: string;
  let defaultCookie: string;
  let defaultLimit: number;
  let html: string;
  let bytes: Buffer;
  const created: string[] = [];

  const jsonRequest = async (path: string, body: unknown, who = cookie, method = "POST") => {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Cookie: who, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  const inspectStoredBytes = async (
    artifact: { uuid: string; size: number; url: string },
    expected = bytes,
  ) => {
    created.push(artifact.uuid);
    expect(artifact.size).toBe(expected.length);
    const frame = new URL(`/__frame/${artifact.uuid}`, artifact.url);
    const response = await fetch(frame, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(response.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), expected)).toBe(0);
  };

  beforeAll(async () => {
    const adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
    const password = `Fixture-${randomUUID()}-Aa!`;
    const email = `artifact-large-${randomUUID()}@example.test`;
    const owner = await createTestUserViaApi(BASE_URL, email, password, "Large artifact owner");
    cookie = formatSessionCookie(BASE_URL, await signInUser(BASE_URL, email, password));
    const defaultEmail = `artifact-default-${randomUUID()}@example.test`;
    const defaultOwner = await createTestUserViaApi(
      BASE_URL,
      defaultEmail,
      password,
      "Default artifact owner",
    );
    defaultCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, defaultEmail, password),
    );
    const quota = await jsonRequest(
      `/api/admin/users/${owner.userId}/artifact-quota`,
      { quotaMb: 256, maxFileSizeMb: 32 },
      adminCookie,
      "PUT",
    );
    expect(quota.status).toBe(200);
    expect(quota.json.data.maxFileSizeBytes).toBe(32 * MIB);
    const inherited = await fetch(
      `${BASE_URL}/api/admin/users/${defaultOwner.userId}/artifact-quota`,
      { headers: { Cookie: adminCookie } },
    );
    expect(inherited.status).toBe(200);
    defaultLimit = (await inherited.json()).data.effective.maxFileSizeBytes;

    // Multibyte characters and escaped JSON characters exercise framing separately
    // from decoded UTF-8 content. The decoded file itself exceeds every old ceiling.
    html = `<html><body>${'0123456789abcdefя"\\\n'.repeat(Math.ceil((21 * MIB) / 21))}</body></html>`;
    bytes = Buffer.from(html, "utf8");
    expect(bytes.length).toBeGreaterThan(20 * MIB);
    expect(bytes.length).toBeLessThan(32 * MIB);
    expect(defaultLimit).toBeLessThan(bytes.length);
    const authenticated = await createAuthenticatedMCPClient({ email, password });
    client = authenticated.client;
    closeClient = authenticated.cleanup;
  });

  afterAll(async () => {
    for (const uuid of created) {
      const response = await fetch(`${BASE_URL}/api/artifacts/${uuid}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
    }
    await closeClient?.();
  });

  test("session REST create and update store exact permitted bytes above 20 MiB", async () => {
    const createdArtifact = await jsonRequest("/api/artifacts", {
      name: "large-rest.html",
      content: html,
    });
    expect(createdArtifact.status).toBe(201);
    await inspectStoredBytes(createdArtifact.json.data);
    const revised = html.replace("<body>", "<body>updated");
    const updated = await jsonRequest(
      `/api/artifacts/${createdArtifact.json.data.uuid}`,
      { content: revised },
      cookie,
      "PUT",
    );
    expect(updated.status).toBe(200);
    const response = await fetch(
      new URL(`/__frame/${createdArtifact.json.data.uuid}`, createdArtifact.json.data.url),
      { headers: { "Sec-Fetch-Dest": "iframe" } },
    );
    expect(response.status).toBe(200);
    expect(
      Buffer.compare(Buffer.from(await response.arrayBuffer()), Buffer.from(revised, "utf8")),
    ).toBe(0);
  });

  test("token JSON stores exact permitted bytes above 20 MiB and remains single-use", async () => {
    const token = await callMCPTool<{ uploadUrl: string }>(client, "artifacts", {
      action: "token",
    });
    const response = await fetch(token.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "large-token-json.html", content: html }),
    });
    expect(response.status).toBe(201);
    await inspectStoredBytes((await response.json()).data);
    const reused = await fetch(token.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "reused.html", content: "<p>reused</p>" }),
    });
    expect(reused.status).toBe(401);
  });

  test("token multipart stores exact permitted file bytes above 20 MiB", async () => {
    const token = await callMCPTool<{ uploadUrl: string }>(client, "artifacts", {
      action: "token",
    });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/html" }), "large.html");
    const response = await fetch(token.uploadUrl, { method: "POST", body: form });
    expect(response.status).toBe(201);
    await inspectStoredBytes((await response.json()).data);
  });

  test("malformed multipart headers are a controlled refusal without consuming the token", async () => {
    const token = await callMCPTool<{ uploadUrl: string }>(client, "artifacts", {
      action: "token",
    });
    const boundary = "artifact-header-boundary";
    const malformed =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="report.html"\r\n' +
      `X-Metadata: ${"x".repeat(17 * 1024)}\r\n\r\n` +
      `<p>ok</p>\r\n--${boundary}--\r\n`;
    const refused = await fetch(token.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: malformed,
    });
    expect(refused.status).toBe(400);
    const expected = Buffer.from("<p>Valid after header refusal</p>");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(expected)], { type: "text/html" }), "valid.html");
    const accepted = await fetch(token.uploadUrl, { method: "POST", body: form });
    expect(accepted.status).toBe(201);
    await inspectStoredBytes((await accepted.json()).data, expected);
  });

  test("MCP stores exact permitted bytes above 20 MiB", async () => {
    const stats = await callMCPTool<{ maxFileSizeBytes: number }>(client, "artifacts", {
      action: "stats",
    });
    expect(stats.maxFileSizeBytes).toBe(32 * MIB);
    const result = await callMCPTool<{ uuid: string; size: number; url: string }>(
      client,
      "artifacts",
      { action: "upload", name: "large-mcp.html", content: html },
    );
    await inspectStoredBytes(result);
  });

  test("the same content is refused with the other user's effective inherited size", async () => {
    const response = await jsonRequest(
      "/api/artifacts",
      { name: "default-refused.html", content: html },
      defaultCookie,
    );
    expect(response.status).toBe(400);
    expect(response.json.error.details.limit).toBe(defaultLimit);
    const listing = await fetch(`${BASE_URL}/api/artifacts`, {
      headers: { Cookie: defaultCookie },
    });
    expect(listing.status).toBe(200);
    expect((await listing.json()).data.artifacts).toEqual([]);
  });
});
