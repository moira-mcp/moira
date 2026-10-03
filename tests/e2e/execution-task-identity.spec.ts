/** A live task rename reaches already-open overview details and a graph-only run page. */
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./fixtures.js";
import { login } from "./helpers/auth-helper.js";
import { settledCamera } from "./helpers/diagram.js";
import { createTestUserViaApi } from "../utils/mcp-auth.js";
import { dockerExecSync } from "../utils/docker-command.js";
import { getTestBaseUrl, isExternalTarget } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const password = "Task-Identity-Password1!";
const flowName = "Order import child flow";
const note = "Diagnostic note: inspect delimiters before retrying";

async function rename(page: Page, executionId: string, taskTitle: string): Promise<void> {
  const detail = await page.request.get(`${baseUrl}/api/executions/${executionId}`);
  expect(detail.status()).toBe(200);
  const current = (await detail.json()).data.execution as {
    revision: number;
    metadataRevisions: { taskIdentity: string };
  };
  const response = await page.request.put(`${baseUrl}/api/executions/${executionId}/task-title`, {
    data: {
      taskTitle,
      expectedRevision: current.revision,
      expectedTaskIdentityRevision: current.metadataRevisions.taskIdentity,
    },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).data.taskIdentity.title).toBe(taskTitle);
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
]) {
  test(`the ${viewport.label} shows separate task, flow and note identities across live renames`, async ({
    page,
  }, testInfo) => {
    if (
      isExternalTarget() ||
      new URL(baseUrl).port !== process.env.DOCKER_PORT ||
      !process.env.DOCKER_CONTAINER_NAME
    ) {
      throw new Error(
        "An explicit isolated local HTTP/Docker target must agree before creating fixtures",
      );
    }
    const prefix = `task-identity-${randomUUID()}`;
    const email = `${prefix}@example.test`;
    const owner = (await createTestUserViaApi(baseUrl, email, password, "Task Identity Owner"))
      .userId;
    const executionId = randomUUID();
    const workflowId = randomUUID();
    const initialTitle = "Import April orders";
    try {
      dockerExecSync([
        "node",
        "--input-type=commonjs",
        "-e",
        `const db=new(require('better-sqlite3'))('/app/data/moira.db');
        db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
        const {owner,prefix,executionId,workflowId,flowName,note,initialTitle}=JSON.parse(process.argv[1]);
        if(!db.prepare('SELECT id FROM user WHERE id=?').get(owner)) throw new Error('Fixture owner missing on selected container');
        const now=Date.now();
        const graph={metadata:{name:flowName,description:'Task identity without authored progress',version:'1.0.0'},nodes:[{id:'start',type:'start',connections:{default:'work'}},{id:'work',type:'agent-directive',metadata:{displayName:'Inspect import inputs'},directive:'Inspect the current import inputs',completionCondition:'Inspected',connections:{success:'end'}},{id:'end',type:'end'}]};
        const context=JSON.stringify({variables:{},nodeStates:{},executionId,workflowId,userId:owner});
        const visits=JSON.stringify([{seq:0,nodeId:'work',exitKey:null,changes:{},enteredAt:now,waited:true}]);
        const identity=JSON.stringify({title:initialTitle,changedAt:now,changeId:'fixture-initial'});
        db.transaction(()=>{
          db.prepare('INSERT INTO workflow (id,userId,slug,name,description,version,graph,visibility,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(workflowId,owner,prefix,flowName,graph.metadata.description,'1.0.0',JSON.stringify(graph),'private',now,now);
          db.prepare("INSERT INTO workflowExecution (executionId,workflowId,userId,state,currentNodeId,waitingForInputNodeId,context,visits,createdAt,updatedAt,lastActivityAt,note,workflowVersion,revision,taskIdentity) VALUES (?,?,?,'running','work','work',?,?,?,?,?,?,'1.0.0',0,?)").run(executionId,workflowId,owner,context,visits,now,now,now,note,identity);
        })(); db.close();`,
        JSON.stringify({ owner, prefix, executionId, workflowId, flowName, note, initialTitle }),
      ]);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login(page, email, password);
      await page.goto(`${baseUrl}/overview`);
      const card = page.locator(`[data-testid="overview-card"][data-run-id="${executionId}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(initialTitle);
      await expect(card).toContainText(flowName);
      const noteFlag = card.getByTestId("overview-flag-note");
      await noteFlag.focus();
      await expect(page.getByRole("tooltip")).toContainText(note);
      await card.getByText(initialTitle, { exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveAccessibleName(initialTitle);
      await expect(dialog).toContainText(flowName);
      await expect(dialog).toContainText(note);
      await expect(page.getByTestId("overview-panel-stages")).toHaveCount(0);

      const overviewTitle = "Import April orders with tax";
      await rename(page, executionId, overviewTitle);
      await expect(card).toContainText(overviewTitle);
      await expect(dialog).toHaveAccessibleName(overviewTitle);
      await expect(dialog).toContainText(note);
      await expect(dialog).toContainText(flowName);
      await page.screenshot({
        path: testInfo.outputPath(`task-identity-overview-${viewport.label}.png`),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      await page.goto(`${baseUrl}/executions/${executionId}`);
      await expect(page.getByTestId("run-task-title")).toHaveText(overviewTitle);
      await expect(page.getByTestId("run-note")).toContainText(note);
      await expect(page.getByTestId("run-header")).toContainText(flowName);
      await expect(page.getByTestId("run-modes")).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Block", exact: true })).toHaveCount(0);
      await settledCamera(page, '[data-testid="run-page"]');
      const inspectorTitle = "Import April orders and credits";
      await rename(page, executionId, inspectorTitle);
      await expect(page.getByTestId("run-task-title")).toHaveText(inspectorTitle);
      await expect(page.getByTestId("run-note")).toContainText(note);
      await expect(page.getByTestId("run-header")).toContainText(flowName);
      await expect(page.getByTestId("run-modes")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`task-identity-inspector-${viewport.label}.png`),
        fullPage: true,
      });

      await page.goto(`${baseUrl}/executions`);
      const executionCard = page.getByTestId("execution-card").filter({ hasText: inspectorTitle });
      await expect(executionCard).toBeVisible();
      await expect(executionCard).toContainText(flowName);
      await expect(executionCard).toContainText(note);
      await page.goto(baseUrl);
      await expect(page.getByTestId(`work-active-${executionId}`)).toContainText(inspectorTitle);
      await expect(page.getByTestId(`work-active-${executionId}`)).toContainText(flowName);
      await expect(page.getByTestId(`work-active-${executionId}`)).toContainText(note);
    } finally {
      dockerExecSync([
        "node",
        "--input-type=commonjs",
        "-e",
        `const db=new(require('better-sqlite3'))('/app/data/moira.db');
        db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
        const {owner,executionId,workflowId}=JSON.parse(process.argv[1]);
        db.transaction(()=>{
          db.prepare('DELETE FROM workflowExecution WHERE executionId=? AND userId=?').run(executionId,owner);
          db.prepare('DELETE FROM workflow WHERE id=? AND userId=?').run(workflowId,owner);
          db.prepare('DELETE FROM user WHERE id=?').run(owner);
        })(); db.close();`,
        JSON.stringify({ owner, executionId, workflowId }),
      ]);
    }
  });
}
