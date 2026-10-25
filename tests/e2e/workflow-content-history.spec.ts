import { randomUUID } from "node:crypto";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { settledCamera } from "./helpers/diagram.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE = getTestBaseUrl();
const ORIGINAL = "Проверить содержимое отчёта перед публикацией.";
const UPDATED = "Опубликовать отчёт без проверки.";
const FLOW_GRAPH = '[data-testid="flow-view"]';

interface WorkflowDetail {
  workflow: WorkflowGraph;
  fileInfo: { revision: number };
}

async function detail(page: Page, id: string): Promise<WorkflowDetail> {
  const response = await page.request.get(`${BASE}/api/workflows/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

async function createHistory(page: Page, withRegistry = false): Promise<string> {
  const workflow: WorkflowGraph = {
    metadata: {
      name: `История отчёта ${randomUUID().slice(0, 8)}`,
      version: "1.0.0",
      description: ORIGINAL,
    },
    ...(withRegistry
      ? {
          variableRegistry: {
            tone: { type: "string" as const, description: "Tone", default: "plain" },
          },
        }
      : {}),
    nodes: [
      { id: "start", type: "start", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        directive: ORIGINAL,
        completionCondition: "Отчёт проверен",
        inputSchema: { type: "object", properties: {} },
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
  const created = await page.request.post(`${BASE}/api/workflows`, { data: { workflow } });
  expect(created.status()).toBe(200);
  const id: string = (await created.json()).data.workflowId;
  const current = await detail(page, id);
  const edited: WorkflowGraph = {
    ...current.workflow,
    metadata: { ...current.workflow.metadata, description: UPDATED },
    nodes: current.workflow.nodes.map((node) =>
      node.type === "agent-directive" ? { ...node, directive: UPDATED } : node,
    ),
  };
  const saved = await page.request.put(`${BASE}/api/workflows/${id}`, {
    data: { workflow: edited, expectedRevision: current.fileInfo.revision },
  });
  expect(saved.status()).toBe(200);
  return id;
}

async function openHistory(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByRole("button", { name: /^(Actions|Действия)$/ }).click();
    await page.getByRole("menuitem", { name: /Version history|История версий/i }).click();
  } else {
    await page.getByTestId("workflow-history-button").click();
  }
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("version-1").click();
  await expect(page.getByTestId("version-content")).toContainText(ORIGINAL);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, phone: false, language: "en" },
  { name: "phone", width: 390, height: 844, phone: true, language: "ru" },
]) {
  test(`workflow history compares and restores persisted content on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await loginAsAdmin(page);
    const id = await createHistory(page);
    try {
      await page.goto(`${BASE}/workflows/${id}?view=graph&lang=${viewport.language}`);
      await expect(page.getByTestId("page-description")).toContainText(UPDATED);
      await openHistory(page, viewport.phone);
      await page.screenshot({
        path: testInfo.outputPath(`history-${viewport.name}-list.png`),
        animations: "disabled",
      });
      const diffTab = page.getByRole("tab", { name: /^(Diff|Изменения)$/ });
      await diffTab.click();
      await expect(diffTab).toHaveAttribute("aria-selected", "true");
      const difference = page.getByTestId("diff-view");
      await expect(difference).toContainText(ORIGINAL);
      await expect(difference).toContainText(UPDATED);
      await expect(diffTab).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath(`history-${viewport.name}-diff.png`),
        animations: "disabled",
      });

      await page.getByTestId("restore-version-button").click();
      await expect(page.getByTestId("restore-confirmation")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`history-${viewport.name}-confirmation.png`),
        animations: "disabled",
      });
      await page.getByTestId("confirm-restore-button").click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByTestId("page-description")).toContainText(ORIGINAL);
      const restored = await detail(page, id);
      expect(restored.workflow.metadata.version).toBe("1.0.0");
      expect(restored.fileInfo.revision).toBe(2);
      await settledCamera(page, FLOW_GRAPH);
      await page.screenshot({
        path: testInfo.outputPath(`history-${viewport.name}-graph.png`),
        animations: "disabled",
      });

      await page.reload();
      await expect(page.getByTestId("page-description")).toContainText(ORIGINAL);
      await openHistory(page, viewport.phone);
      await expect(page.getByTestId("version-3")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`history-${viewport.name}-restored.png`),
        animations: "disabled",
      });
    } finally {
      await page.request.delete(`${BASE}/api/workflows/${id}`);
    }
  });
}

test("inspecting history cannot discard an unsaved workflow edit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsAdmin(page);
  const id = await createHistory(page, true);
  try {
    await page.goto(`${BASE}/workflows/${id}?view=graph&edit=1`);
    await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
    await page.getByRole("tab", { name: /^(Variables|Переменные)$/ }).click();
    const draft = page.getByTestId("registry-tone-default");
    await expect(draft).toBeVisible();
    await draft.fill('"warm"');
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");

    await openHistory(page, false);
    await expect(page.getByTestId("restore-version-button")).toBeDisabled();
    await expect(page.getByRole("dialog")).toContainText(/unsaved|несохранён/i);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(draft).toHaveValue('"warm"');
    const stored = await detail(page, id);
    expect(stored.fileInfo.revision).toBe(1);
    expect(stored.workflow.metadata.description).toBe(UPDATED);
    expect(stored.workflow.variableRegistry?.tone.default).toBe("plain");
  } finally {
    await page.request.delete(`${BASE}/api/workflows/${id}`);
  }
});

test("a concurrent saved edit remains intact and its restore conflict stays visible", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsAdmin(page);
  const id = await createHistory(page);
  try {
    await page.goto(`${BASE}/workflows/${id}?view=graph&lang=en`);
    await expect(page.getByTestId("page-description")).toContainText(UPDATED);
    await openHistory(page, false);
    const current = await detail(page, id);
    const concurrent = "Актуальная правка другого редактора.";
    const changed = await page.request.put(`${BASE}/api/workflows/${id}`, {
      data: {
        workflow: {
          ...current.workflow,
          metadata: { ...current.workflow.metadata, description: concurrent },
        },
        expectedRevision: current.fileInfo.revision,
      },
    });
    expect(changed.status()).toBe(200);
    await page.getByTestId("restore-version-button").click();
    await page.getByTestId("confirm-restore-button").click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/revision|reload/i);
    await expect(page.getByTestId("restore-confirmation")).toBeVisible();
    const persisted = await detail(page, id);
    expect(persisted.workflow.metadata.description).toBe(concurrent);
    expect(persisted.fileInfo.revision).toBe(2);
    const history = await page.request.get(`${BASE}/api/workflows/by-id/${id}/history`);
    expect(history.status()).toBe(200);
    expect(
      (await history.json()).data.revisions.map((row: { revision: number }) => row.revision),
    ).toEqual([3, 2, 1]);
    await page.screenshot({
      path: testInfo.outputPath("history-concurrent-edit-refusal.png"),
      animations: "disabled",
    });
  } finally {
    await page.request.delete(`${BASE}/api/workflows/${id}`);
  }
});
