/**
 * The real browser consumes the server-owned node-type catalog.
 *
 * The browser receives one distinctive extension declaration at the HTTP boundary, while the real
 * backend owns workflow storage, authentication and the base built-in catalog. This isolates the
 * browser's responsibility from the real-registry endpoint integration covered at its own level.
 *
 * What the browser has to do with that declaration is name the node by the title its type declares
 * and read the node's stored configuration against the schema the type declares, saying key by key
 * what it found: a declared key with a value, a declared key left unset, and a key the node carries
 * that its type never declared. Since the node sidebar was retired, that readout is a section of
 * the right panel's node level, reached by clicking the node's card on the technical graph.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test("custom catalog node renders its owner and config schema in the node panel", async ({
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

  // A plain definition with no process view: the right panel stands beside the graph regardless,
  // and its node level is where a node's configuration is read.
  const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
    headers: { "Content-Type": "application/json" },
    data: {
      visibility: "private",
      workflow: {
        metadata: {
          name: `Custom Node Catalog Visual Check ${Date.now()}`,
          version: "1.0.0",
          description: "Exercises the generic catalog renderer.",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "send-message" },
          },
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
    await page.goto(`${BASE_URL}/workflows/admin/${slug}?view=graph`);
    await expect(page.locator('[data-graph-node="send-message"]')).toBeVisible({ timeout: 20000 });

    // The node is drawn from the catalog rather than as an unknown type: the transformer says so
    // in the class React Flow puts on it, and it logs no "not in the catalog" warning.
    await expect(page.locator(".react-flow__node-catalog")).toHaveCount(1);
    await page.locator('[data-graph-node="send-message"]').click();

    const panel = page.getByTestId("node-panel");
    await expect(panel).toHaveAttribute("data-node-id", "send-message");
    // The node carries no label of its own, so the heading falls back to the title the type
    // declares — the extension's own words, not the raw type string or the node id.
    await expect(panel.getByRole("heading")).toHaveText("Отправка сообщения");
    // The type itself is still said exactly, so the reader can match the node to its declaration.
    await expect(page.getByTestId("node-panel-type")).toHaveText("corporate-messenger.send");
    const configuration = page.getByTestId("node-panel-configuration");
    // The extension that owns the type, with its version, names who the configuration belongs to.
    await expect(configuration).toContainText(/corporate-messenger 2\.1\.0/);
    // A declared key with a value, a declared key left unset, and a key the type never declared —
    // each said in the reader's terms rather than dumped as raw JSON.
    await expect(configuration.getByText("Message body", { exact: true })).toBeVisible();
    await expect(configuration.getByText("hello from extension", { exact: true })).toBeVisible();
    await expect(configuration.getByText("login", { exact: true })).toBeVisible();
    await expect(configuration.getByText("not set", { exact: true })).toBeVisible();
    await expect(configuration.getByText("chat", { exact: true })).toBeVisible();
    await expect(
      configuration.getByText("not declared by this node type", { exact: true }),
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
