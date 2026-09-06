/**
 * The real browser consumes the server-owned node-type catalog.
 *
 * The browser receives one distinctive extension declaration at the HTTP boundary, while the real
 * backend owns workflow storage, authentication and the base built-in catalog. This isolates the
 * browser's responsibility from the real-registry endpoint integration covered at its own level.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test("custom catalog node renders its declaration, owner and config schema", async ({
  page,
}, testInfo) => {
  const anonymousCatalog = await page.request.get(`${BASE_URL}/api/node-types`);
  expect(anonymousCatalog.status()).toBe(401);

  await loginAsAdmin(page);

  const authenticatedCatalog = await page.request.get(`${BASE_URL}/api/node-types`);
  expect(authenticatedCatalog.status()).toBe(200);
  const catalogEnvelope = await authenticatedCatalog.json();
  await page.route("**/api/node-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...catalogEnvelope,
        data: {
          ...catalogEnvelope.data,
          extensionsAvailable: true,
          nodeTypes: [
            ...catalogEnvelope.data.nodeTypes,
            {
              type: "corporate-messenger.send",
              title: "Отправка сообщения",
              description: "Sends a message to the configured recipient.",
              origin: "extension",
              extensionName: "corporate-messenger",
              extensionVersion: "2.1.0",
              schemaScope: "config",
              schema: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", description: "Message body" },
                  login: { type: "string", description: "Recipient login" },
                },
              },
            },
          ],
        },
      }),
    });
  });

  const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
    headers: { "Content-Type": "application/json" },
    data: {
      visibility: "private",
      workflow: {
        metadata: {
          name: "Custom Node Catalog Visual Check",
          version: "1.0.0",
          description: "Exercises the generic catalog renderer.",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "send-message" } },
          {
            type: "corporate-messenger.send",
            id: "send-message",
            config: { text: "hello from extension", chat: "legacy-room" },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    },
  });
  expect(createResponse.status()).toBe(200);
  const created = await createResponse.json();
  const workflowId = created.data?.workflowId as string;
  const slug = created.data?.slug as string;
  expect(workflowId).toBeTruthy();
  expect(slug).toBeTruthy();

  // The local container intentionally has no runner in this unit, while the catalog response above
  // represents a connected extension. Keep the browser's two inputs coherent: endpoint/validator
  // integration owns the real registry state, and this test owns presentation of the installed one.
  await page.route("**/api/workflows/admin/*", async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    envelope.data.validation = {
      isValid: true,
      nodeValidation: {
        ...envelope.data.validation.nodeValidation,
        "send-message": { isValid: true, errors: [], warnings: [] },
      },
      globalErrors: [],
      globalWarnings: [],
    };
    await route.fulfill({ response, json: envelope });
  });

  try {
    const catalogWarnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("WorkflowTransformer")) {
        catalogWarnings.push(message.text());
      }
    });
    await page.goto(`${BASE_URL}/workflows/admin/${slug}`);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    const customNode = page.locator(".react-flow__node-catalog");
    await expect(customNode).toHaveCount(1);
    await customNode.click();

    const sidebar = page.locator('[data-testid="workflow-sidebar"]');
    await expect(sidebar.getByText("Отправка сообщения", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("corporate-messenger.send", { exact: true })).toBeVisible();
    await expect(sidebar.getByText(/corporate-messenger 2\.1\.0/)).toBeVisible();
    await expect(sidebar.getByText("Message body", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("hello from extension", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("login", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("not set", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("chat", { exact: true })).toBeVisible();
    await expect(
      sidebar.getByText("not declared by this node type", { exact: true }),
    ).toBeVisible();
    expect(catalogWarnings).toEqual([]);

    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach("catalog-custom-extension-node", {
      body: screenshot,
      contentType: "image/png",
    });
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  }
});
