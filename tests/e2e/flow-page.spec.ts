/**
 * The flow page on Quick Task, in its two views: the map (the derived process as a diagram with
 * its contents sidebar and the block panel beside it) and the technical graph, where a step opens
 * as the node level of that same panel — the separate node sidebar the page used to carry is gone
 * and its sections live in the panel, while the flow's own description and tags live in the page
 * header. Covers reading a bundled flow, a non-owner without edit mode, an owner's edit session on
 * a private copy — a block renamed to ninety characters (the map card clamps it, the facts stay
 * inside the card), a relabelled return, a moved routing node reported as a diagnostic before any
 * save, an edited directive and registry default, the export diff, a save that persists and
 * advances the revision, a save refused on a stale revision (409) and on an invalid definition
 * (400) with the edits kept — a node drawn from the server's node-type catalog read in the node
 * panel, and the page usable on a phone.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { GRAPH, MAP, graphOverview, openPanelSection, settledCamera } from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

async function copyQuickTask(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE_URL}/api/workflows/moira/quick-task/copy`, {
    data: { newName: `Flow page edit ${Date.now()}` },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { workflowId: string } }).data.workflowId;
}

async function detailOf(page: Page, id: string) {
  const response = await page.request.get(`${BASE_URL}/api/workflows/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: any }).data;
}

/** Select a block through the map's contents sidebar: the panel then carries that block. */
async function openBlock(page: Page, blockId: string): Promise<void> {
  await page.getByTestId(`map-contents-${blockId}`).click();
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", blockId);
}

/** The block panel's steps come folded; a spec that reads or edits them opens the section. */
async function openSteps(page: Page): Promise<void> {
  await openPanelSection(page, "panel-section-steps");
}

test("reads a bundled flow as a process on the map and explains it", async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);

  const flow = page.getByTestId("flow-page");
  // The map is the default view of a workflow that has a process view.
  await expect(flow).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("map-view")).toBeVisible();
  await expect(page.getByTestId("map-contents-list").locator("[data-block-id]")).toHaveCount(7);
  await expect(page.getByTestId("flow-edit-toggle")).toHaveCount(0);
  // The header carries what the flow is: its description on its own line, its tags and how many
  // nodes it declares — the facts the retired node sidebar used to hold.
  await expect(page.getByTestId("flow-header")).toBeVisible();
  await expect(page.getByTestId("page-description")).toContainText(/\w/);
  expect(await page.getByTestId("flow-tag").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("flow-node-count")).toContainText(/\d+/);
  // A definition has no run: no status chips and no "the run has not reached" wording, and the
  // block instead carries what the version typically costs.
  await expect(page.locator("span[data-status]")).toHaveCount(0);
  await expect(page.getByTestId("map-view")).not.toContainText(
    /has not reached this block|ещё не дошёл/,
  );
  // The explanation of the view is one toolbar button: the body appears only after the reader
  // asks for it, so the diagram keeps the column.
  await expect(page.getByTestId("diagram-guide-body")).toHaveCount(0);
  await page.getByTestId("diagram-guide-toggle").click();
  await expect(page.getByTestId("diagram-guide-body")).toBeVisible();
  await page.getByTestId("diagram-guide-toggle").click();
  await expect(page.getByTestId("diagram-guide-body")).toHaveCount(0);
  // The block panel opens on the first block and drills into its steps with their evidence.
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "scope");
  await openSteps(page);
  await expect(
    page.getByTestId("block-detail").locator('[data-node-id="get-task"] [data-node-inputs]'),
  ).toBeVisible();
  await expect(page.getByTestId("typical-durations")).toHaveAttribute("data-block-id", "scope");
  await expect(page.getByTestId("flow-panel").getByTestId("registry-panel")).toHaveCount(0);
  await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
  await expect(page.getByTestId("registry-current_plan_file")).toBeVisible();

  // The map draws every transition at rest, returns dashed and muted, and names each one on the
  // ports of the two cards it joins. Hovering a port lights that connection; a block deep-linked
  // into the page keeps all of its own connectors lit while nothing is hovered.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=execute`);
  await expect(page.locator(`${MAP} [data-block-id="execute"]`)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-edge-kind="return"]').first()).toBeVisible();
  await expect(page.locator("[data-edge-label]")).toHaveCount(0);
  const executeLinks = await page
    .locator(`${MAP} [data-block-id="execute"] [data-port]`)
    .evaluateAll((ports) => ports.map((port) => port.getAttribute("data-transition")!));
  expect(executeLinks.length).toBeGreaterThan(0);
  // A connection has a port at each end, so the distinct transitions are what is counted.
  const litPorts = () =>
    page
      .locator(`${MAP} [data-port][data-lit="true"]`)
      .evaluateAll((ports) => [
        ...new Set(ports.map((port) => port.getAttribute("data-transition")!)),
      ]);
  // Selecting a block lights every connector it takes part in, on its own card and on the cards
  // at the far ends.
  await expect.poll(litPorts).toEqual(expect.arrayContaining([...new Set(executeLinks)]));

  // Hovering one port narrows that to the single connection under the pointer.
  const onePort = page.locator(`${MAP} [data-block-id="execute"] [data-port="out"]`).first();
  const oneLink = await onePort.getAttribute("data-transition");
  await onePort.hover();
  await expect.poll(litPorts).toEqual([oneLink]);
  await expect(page.locator(`[data-transition="${oneLink}"][data-focused="true"]`)).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect.poll(litPorts).toEqual(expect.arrayContaining([...new Set(executeLinks)]));

  // The contents sidebar's finder is folded into the toolbar; opened, it answers "which block is
  // this step in" and selects that block.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=plan-review`);
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan-review");
  await openSteps(page);
  await expect(page.getByTestId("block-detail").locator("[data-node-id]")).toHaveCount(2);
  await page.getByTestId("map-toolbar").getByTestId("toolbar-finder").click();
  await page.getByTestId("map-node-finder").fill("fix-issues");
  await page.locator('[data-node-match="fix-issues"]').click();
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "verify");
});

// Reading a bundled flow continues in the two tests below. Each opens the page afresh several
// times, and one test holding all of those loads would not fit the per-test budget on a CI runner.

test("the technical graph is the page's other view, and a link to a retired view opens the map", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const flow = page.getByTestId("flow-page");

  // The technical graph is the other view: its own toolbar, the same panel beside it, and no
  // separate node sidebar any more.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page.getByTestId("graph-toolbar")).toBeVisible();
  await expect(page.getByTestId("flow-panel")).toBeVisible();
  await expect(page.getByTestId("workflow-sidebar")).toHaveCount(0);

  // A link written for one of the views this page used to have resolves to the map.
  for (const legacy of ["outline", "canvas", "lanes", "split", "nonsense"]) {
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${legacy}`);
    await expect(flow).toHaveAttribute("data-view", "map");
    await expect(page.getByTestId("map-view")).toBeVisible();
  }
});

test("a step in the block panel opens on the graph as the node level of the panel, and the walkthrough opens from its link", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const flow = page.getByTestId("flow-page");

  // A step in the block panel focuses it on the graph, which switches the page's view; clicking
  // its card there opens the node level of the panel, which names the other end of every
  // connection by node id (or display name), never by the type of the node the edge reaches —
  // "Decision" names nothing when several edges lead to different routing nodes.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=verify`);
  await openSteps(page);
  await page.getByTestId("block-detail").locator('[data-node-id="final-review"] button').click();
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page).toHaveURL(/view=graph/);
  // The card is clicked where the focus brings the camera to rest.
  await settledCamera(page, GRAPH);
  await page.locator('[data-graph-node="final-review"]').click();
  const nodePanel = page.getByTestId("node-panel");
  await expect(nodePanel).toHaveAttribute("data-node-id", "final-review");
  const connections = page.getByTestId("node-panel-connections");
  await expect(connections).toBeVisible();
  await expect(connections).toContainText("route-operating-mode-result-presentation");
  const repairConnection = connections.getByRole("button", { name: "Repair review findings" });
  await expect(repairConnection).toBeVisible();
  await expect(connections).not.toContainText("Decision");

  // The walkthrough lives in the URL; `walkthrough.spec.ts` runs every one of its steps through
  // in both views and checks each anchor resolves.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?guide=1`);
  await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "process");
  await expect(page.locator('[data-guide-target="process"]')).toBeVisible();
});

/** A ninety-character block name: the map card must clamp it rather than grow or overflow. */
const LONG_BLOCK_NAME =
  "Draft the plan (edited) with every unit, its acceptance evidence and the gate it ends with";

async function openEditing(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE_URL}/workflows/${id}?edit=1`);
  await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
  await expect(page.getByTestId("flow-edit-count")).toContainText("0");
}

test("an owner edits the definition in place; the save persists and advances the revision", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await copyQuickTask(page);
  try {
    expect((await detailOf(page, id)).fileInfo.revision).toBe(0);
    await openEditing(page, id);

    // Rename a block in its own panel. Switching blocks happens in the app: a page load would
    // discard the in-memory edits.
    await openBlock(page, "plan");
    await page.getByTestId("edit-block-label-plan").fill(LONG_BLOCK_NAME);
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    // The map's card clamps the ninety-character name: the title band shows it, the name takes at
    // most the two lines the card allows, and the name and the facts both stay inside the card —
    // a name that wrapped freely would push the facts past the card's bottom edge.
    const card = page.locator(`${MAP} [data-block-id="plan"]`);
    await expect(card.locator("[data-step-title]")).toContainText(LONG_BLOCK_NAME.slice(0, 20));
    const geometry = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const title = element.querySelector("[data-step-title]")!.getBoundingClientRect();
      const facts = element.querySelector("[data-step-facts]")!.getBoundingClientRect();
      const inside = (r: DOMRect) =>
        r.left >= box.left - 1 &&
        r.right <= box.right + 1 &&
        r.top >= box.top - 1 &&
        r.bottom <= box.bottom + 1;
      return {
        titleInside: inside(title),
        factsInside: inside(facts),
        factsBelowTitle: facts.top >= title.bottom - 1,
        // The title band is the card's top strip: two clamped lines of a 16 px title plus its
        // own padding never reach a third of a card that is at least 120 px tall.
        titleBandHeight: Math.round(title.height),
        cardHeight: Math.round(box.height),
      };
    });
    expect(geometry.titleInside).toBe(true);
    expect(geometry.factsInside).toBe(true);
    expect(geometry.factsBelowTitle).toBe(true);
    expect(geometry.titleBandHeight).toBeLessThanOrEqual(60);

    // Relabel the repair return, which belongs to the review block that it re-enters.
    await openBlock(page, "plan-review");
    await page.locator('[data-edges="repair-plan.success"]').click();
    await page.getByTestId("edit-transition-label").fill("plan repaired");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("flow-edit-count")).toContainText("2");

    // Move a routing node to another block: the diagnostic appears without a round trip and
    // blocks the save; moving it back clears it.
    await openSteps(page);
    await page.getByTestId("edit-owner-plan-review").click();
    await page.getByRole("option", { name: "Understand the task" }).click();
    await expect(page.getByTestId("flow-diagnostics")).toContainText("unlabeled-edge");
    await expect(page.getByTestId("flow-edit-save")).toBeDisabled();
    // …and on the offending step itself, in the block it now sits in.
    await openBlock(page, "scope");
    await openSteps(page);
    await expect(
      page.locator('[data-node-id="plan-review"] [data-testid="inline-diagnostic"]'),
    ).toHaveAttribute("data-diagnostic", /unlabeled-edge/);
    await page.getByTestId("edit-owner-plan-review").click();
    await page.getByRole("option", { name: "Independent plan review" }).click();
    await expect(page.getByTestId("flow-diagnostics")).toHaveCount(0);
    await expect(page.getByTestId("inline-diagnostic")).toHaveCount(0);
    await expect(page.getByTestId("flow-edit-save")).toBeEnabled();

    // Edit a directive and a registry default; the export lists exactly what changes (the
    // ownership edit that ended where it started is not a change).
    await openBlock(page, "plan");
    await openSteps(page);
    await page.getByTestId("edit-node-create-plan-directive").fill("Write the plan (edited).");
    await openBlock(page, "execute");
    await openSteps(page);
    await page
      .getByTestId("edit-node-close-completed-step-expressions")
      .fill("current_step = current_step + 2");
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await page.getByTestId("registry-total_steps-default").fill("4");
    // The whole declaration is editable as JSON Schema (a keyword the field editors do not
    // offer) in the row's expanded body.
    await page.getByTestId("registry-total_steps-toggle").click();
    await page
      .getByTestId("registry-total_steps-schema")
      .fill('{"type":"number","description":"Steps in the plan","default":4,"minimum":1}');
    await page.getByTestId("flow-edit-export").getByRole("button").click();
    await expect(page.locator("[data-export-path]")).toHaveCount(5);
    await expect(
      page.locator('[data-export-path="nodes[close-completed-step].expressions"]'),
    ).toBeVisible();
    await expect(page.locator('[data-export-path="progress.nodes[1].label"]')).toBeVisible();
    await expect(
      page.locator('[data-export-path="nodes[repair-plan].connectionLabels.success"]'),
    ).toBeVisible();
    await expect(page.locator('[data-export-path="nodes[create-plan].directive"]')).toBeVisible();
    await expect(page.locator('[data-export-path="variableRegistry.total_steps"]')).toBeVisible();

    // Save: persisted, revision advanced, re-derived on reload.
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-edit-count")).toContainText("0");
    const saved = await detailOf(page, id);
    expect(saved.fileInfo.revision).toBe(1);
    expect(saved.workflow.progress.nodes[1].label).toBe(LONG_BLOCK_NAME);
    expect(saved.workflow.nodes.find((n: any) => n.id === "create-plan").directive).toBe(
      "Write the plan (edited).",
    );
    expect(saved.workflow.variableRegistry.total_steps).toEqual({
      type: "number",
      description: "Steps in the plan",
      default: 4,
      minimum: 1,
    });
    expect(
      saved.workflow.nodes.find((n: any) => n.id === "close-completed-step").expressions,
    ).toEqual(["current_step = current_step + 2"]);
    await page.goto(`${BASE_URL}/workflows/${id}?block=plan`);
    await expect(page.getByTestId("block-detail")).toContainText(LONG_BLOCK_NAME);
    await openSteps(page);
    await expect(page.getByTestId("block-detail")).toContainText("Write the plan (edited).");
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});

test("a save against a stale revision or with an invalid definition is refused and the edits stay", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await copyQuickTask(page);
  try {
    // Stale revision: another writer advanced the workflow after this page loaded.
    await openEditing(page, id);
    const current = await detailOf(page, id);
    const elsewhere = await page.request.put(`${BASE_URL}/api/workflows/${id}`, {
      data: {
        workflow: {
          ...current.workflow,
          metadata: { ...current.workflow.metadata, description: "moved on" },
        },
        expectedRevision: 0,
      },
    });
    expect(elsewhere.status()).toBe(200);
    await page.getByTestId("edit-block-label-scope").fill("Understand the task (stale)");
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-save-error")).toContainText(/reload|перезагрузите/i);
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    await expect(page.getByTestId("edit-block-label-scope")).toHaveValue(
      "Understand the task (stale)",
    );
    expect((await detailOf(page, id)).fileInfo.revision).toBe(1);

    // Invalid definition: a default that does not match its declared type is refused (400).
    await openEditing(page, id);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await page.getByTestId("registry-total_steps-default").fill('"four"');
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-save-error")).toBeVisible();
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    expect((await detailOf(page, id)).fileInfo.revision).toBe(1);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});

test("a node drawn from the catalog shows its configuration, playbooks and validation in the node panel", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // One extension declaration is added at the HTTP boundary, as a connected extension would
  // serve it; the real backend still owns storage, authentication and the built-in catalog.
  const catalog = await (await page.request.get(`${BASE_URL}/api/node-types`)).json();
  await page.route("**/api/node-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...catalog,
        data: {
          ...catalog.data,
          extensionsAvailable: true,
          nodeTypes: [
            ...catalog.data.nodeTypes,
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

  const created = await (
    await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: `Catalog node in the panel ${Date.now()}`,
            version: "1.0.0",
            description: "Exercises the generic catalog renderer in the node panel.",
            tags: ["catalog", "extension"],
          },
          progress: {
            title: "Notify the team",
            goal: "Send one message through the messenger extension.",
            nodes: [
              {
                id: "notify",
                label: "Notify the team",
                content: { summary: "The messenger extension sends the update." },
              },
            ],
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "send-message" },
              progressNodeId: "notify",
            },
            {
              type: "corporate-messenger.send",
              id: "send-message",
              directive: "Send the update, following {{playbook:review-standard}}.",
              config: { text: "hello from extension", chat: "legacy-room" },
              connections: { success: "end" },
              progressNodeId: "notify",
            },
            { type: "end", id: "end", progressNodeId: "notify" },
          ],
        },
      },
    })
  ).json();
  const workflowId = created.data.workflowId as string;
  const slug = created.data.slug as string;
  expect(workflowId).toBeTruthy();

  // The container has no extension runner in this unit, so the node's validation is supplied at
  // the same boundary as the catalog: the panel's job is to show what it is given.
  const warning = "The recipient login is not configured for this message.";
  await page.route("**/api/workflows/admin/*", async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    envelope.data.validation = {
      ...envelope.data.validation,
      nodeValidation: {
        ...envelope.data.validation.nodeValidation,
        "send-message": { isValid: true, errors: [], warnings: [warning] },
      },
    };
    await route.fulfill({ response, json: envelope });
  });

  try {
    await page.goto(`${BASE_URL}/workflows/admin/${slug}?view=graph`);
    await expect(page.locator('[data-graph-node="send-message"]')).toBeVisible({ timeout: 20000 });
    // The node is drawn from the catalog, not as an unknown type.
    await expect(page.locator(".react-flow__node-catalog")).toHaveCount(1);

    // The graph opens on its first step; the card after it lies past the pane's edge.
    await graphOverview(page);
    await page.locator('[data-graph-node="send-message"]').click();
    const panel = page.getByTestId("node-panel");
    await expect(panel).toHaveAttribute("data-node-id", "send-message");

    // Configuration: the node's own config read against the schema its type declares, with the
    // extension that provides the type named in the section's summary. What that readout says
    // about each key is `node-type-catalog.spec.ts`; what matters here is that the section is in
    // the panel at all, since it used to live in the retired node sidebar.
    const configuration = page.getByTestId("node-panel-configuration");
    await expect(configuration).toBeVisible();
    await expect(configuration).toContainText(/corporate-messenger 2\.1\.0/);
    await expect(configuration.getByText("hello from extension", { exact: true })).toBeVisible();

    // Playbooks the node's texts name, and the validation the definition carries for it — both
    // sections the retired node sidebar used to own.
    await expect(page.getByTestId("node-panel-playbooks")).toBeVisible();
    await expect(page.getByTestId("node-playbook-references")).toContainText("review-standard");
    await expect(page.getByTestId("node-panel-validation")).toContainText(warning);

    // The flow's own description and tags are the header's, not the panel's.
    await expect(page.getByTestId("page-description")).toContainText(
      "Exercises the generic catalog renderer in the node panel.",
    );
    expect(
      await page.getByTestId("flow-tag").evaluateAll((tags) => tags.map((t) => t.textContent)),
    ).toEqual(["catalog", "extension"]);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  }
});

test("a phone keeps the flow page readable: contents under the diagram, panel under both, no overflow", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("map-view")).toBeVisible();
  const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
  const contents = (await page.getByTestId("map-contents").boundingBox())!;
  expect(contents.y).toBeGreaterThanOrEqual(diagram.y + diagram.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("diagram-guide-body")).toHaveCount(0);
  const picture = (await page.getByTestId("flow-view").boundingBox())!;
  const panel = (await page.getByTestId("flow-panel").boundingBox())!;
  expect(picture.height).toBeGreaterThanOrEqual(900 * 0.4);
  expect(panel.y).toBeGreaterThanOrEqual(picture.y + picture.height - 1);
});
