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
import { graphOverview } from "./helpers/diagram.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine/types";

const BASE_URL = getTestBaseUrl();

test("authored file paths, structured progress and integer declarations survive an editor save", async ({
  page,
}, testInfo) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workflow: WorkflowGraph = {
    metadata: {
      name: `Authored model browser ${Date.now()}`,
      version: "1.0.0",
      description: "Full definition editing",
    },
    variableRegistry: {
      count: { type: "integer", description: "Completed items", minimum: 0, default: 0 },
      items: {
        type: "array",
        description: "Work items",
        items: { type: "string" },
        default: ["First"],
      },
      source: { type: "string", description: "File source", default: "A real authored file" },
    },
    runtimePolicy: { externalVariableWrites: { count: { allowedNodeIds: ["review"] } } },
    systemReminder: "Keep all authored fields.",
    progress: {
      nodes: [
        {
          id: "work",
          label: "Prepare and review",
          content: { summary: "Prepare the source file and review the result." },
          list: { items: "items", current: "count", indexBase: 0 },
        },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "work", connections: { default: "files" } },
      {
        id: "files",
        type: "materialize",
        progressNodeId: "work",
        basePath: "./workspace",
        files: [{ path: "brief.md", from: "source" }],
        connections: { success: "review" },
      },
      {
        id: "review",
        type: "agent-directive",
        progressNodeId: "work",
        directive: "Inspect the file.",
        completionCondition: "Reviewed.",
        humanGate: { label: "Approve", notify: "off" },
        progressActiveLabel: "Review item {{count}}",
        progressActiveContent: {
          summary: "Inspect the authored brief",
          details: ["Read all source material"],
          outcome: "Record a decision",
          next: "Deliver the result",
        },
        connections: { success: "end" },
      },
      { id: "end", type: "end", progressNodeId: "work" },
    ],
  };
  const createdResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
    data: { visibility: "private", workflow },
  });
  expect(createdResponse.status()).toBe(200);
  const created = await createdResponse.json();
  const id: string = created.data.workflowId;
  const detail = async () => {
    const response = await page.request.get(`${BASE_URL}/api/workflows/${id}`);
    expect(response.status()).toBe(200);
    return (await response.json()).data;
  };
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  try {
    const before = await detail();
    await page.goto(`${BASE_URL}/workflows/${id}?view=graph&edit=1`);
    await expect(page.getByTestId("flow-edit-toggle")).toHaveAttribute("aria-pressed", "true");
    await graphOverview(page);
    await page.locator('[data-graph-node="files"]').click();
    const panel = page.getByTestId("node-panel");
    await expect(panel).toHaveAttribute("data-node-id", "files");
    await expect(panel.getByText("brief.md", { exact: true })).toBeVisible();
    await panel.getByText("brief.md", { exact: true }).scrollIntoViewIfNeeded();
    await capture("authored-materialize-paths");

    await page.locator('[data-graph-node="review"]').click();
    await expect(panel).toHaveAttribute("data-node-id", "review");
    const content = page.getByTestId("node-panel-progress-content");
    await content.scrollIntoViewIfNeeded();
    await expect(content).toBeVisible();
    for (const text of [
      "Inspect the authored brief",
      "Read all source material",
      "Record a decision",
      "Deliver the result",
    ]) {
      await expect(content).toContainText(text);
    }
    await capture("authored-structured-progress");

    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await page.getByTestId("registry-count-type").click();
    await expect(page.getByRole("option", { name: "integer", exact: true })).toBeVisible();
    await capture("authored-integer-option");
    await page.getByRole("option", { name: "integer", exact: true }).click();
    await expect(page.getByTestId("registry-count-type")).toHaveText("integer");
    await page.getByTestId("registry-count-toggle").click();
    await page.getByTestId("registry-count-description").fill("Completed items after review");
    await expect(page.getByTestId("flow-edit-save")).toBeEnabled();
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-edit-count")).toContainText("0");
    const after = await detail();
    expect(after.fileInfo.revision).toBeGreaterThan(before.fileInfo.revision);
    expect(after.workflow).toEqual({
      ...before.workflow,
      variableRegistry: {
        ...before.workflow.variableRegistry,
        count: {
          ...before.workflow.variableRegistry.count,
          description: "Completed items after review",
        },
      },
    });
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});

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
    // The graph opens on its first step; the card after it lies past the pane's edge.
    await graphOverview(page);
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
