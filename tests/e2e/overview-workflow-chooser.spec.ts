/** The real overview chooser includes readable flow names beyond two summary pages. */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { login } from "./helpers/auth-helper.js";
import { createTestUserViaApi } from "../utils/mcp-auth.js";
import { dockerExecSync } from "../utils/docker-command.js";
import { getTestBaseUrl, isExternalTarget } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const password = "Chooser-Smoke-Password1!";
const taskTitle = "Inspect the late catalog entry";
const chosenName = "Chooser flow 204";

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
]) {
  test(`the ${viewport.label} chooser selects a flow beyond two summary pages`, async ({
    page,
  }) => {
    if (
      isExternalTarget() ||
      new URL(baseUrl).port !== process.env.DOCKER_PORT ||
      !process.env.DOCKER_CONTAINER_NAME
    ) {
      throw new Error(
        "An explicit isolated local HTTP/Docker target must agree before creating fixtures",
      );
    }
    const prefix = `chooser-${randomUUID()}`;
    const email = `${prefix}@example.test`;
    const owner = (await createTestUserViaApi(baseUrl, email, password, "Chooser Owner")).userId;
    const executionId = randomUUID();
    let chosenId = "";
    const requests: Array<{ offset: number; limit: number }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === baseUrl &&
        url.pathname === "/api/workflows" &&
        url.searchParams.has("offset")
      ) {
        requests.push({
          offset: Number(url.searchParams.get("offset")),
          limit: Number(url.searchParams.get("limit")),
        });
      }
    });

    try {
      // Parameterized writes happen inside the container, preserving the live WAL and foreign keys.
      chosenId = dockerExecSync([
        "node",
        "--input-type=commonjs",
        "-e",
        `
        const Database=require('better-sqlite3'), {randomUUID}=require('node:crypto');
        const db=new Database('/app/data/moira.db');
        db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
        const {owner,prefix,executionId,taskTitle}=JSON.parse(process.argv[1]);
        if(!db.prepare('SELECT id FROM user WHERE id=?').get(owner)) throw new Error('Fixture owner missing on selected container');
        let chosenId;
        const now=Date.now();
        db.transaction(()=>{
          const insert=db.prepare('INSERT INTO workflow (id,userId,slug,name,description,version,graph,visibility,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
          for(let index=0;index<205;index++) {
            const id=randomUUID(), suffix=String(index).padStart(3,'0'), name='Chooser flow '+suffix;
            const graph={metadata:{name,description:'Chooser pagination fixture',version:'1.0.0'},progress:{title:taskTitle,nodes:[{id:'inspect',label:'Inspect catalog',content:{summary:'Inspect the selected flow'}}]},nodes:[{id:'start',type:'start',progressNodeId:'inspect',connections:{default:'work'}},{id:'work',type:'agent-directive',progressNodeId:'inspect',directive:'Inspect the chosen flow',completionCondition:'Inspected',connections:{success:'end'}},{id:'end',type:'end',progressNodeId:'inspect'}]};
            insert.run(id,owner,prefix+'-'+suffix,name,graph.metadata.description,'1.0.0',JSON.stringify(graph),'private',now-index,now);
            if(index===204) chosenId=id;
          }
          const context=JSON.stringify({variables:{},nodeStates:{},executionId,workflowId:chosenId,userId:owner});
          const visits=JSON.stringify([{seq:0,nodeId:'work',exitKey:null,changes:{},enteredAt:now,waited:true}]);
          db.prepare("INSERT INTO workflowExecution (executionId,workflowId,userId,state,currentNodeId,waitingForInputNodeId,context,visits,createdAt,updatedAt,lastActivityAt,note,workflowVersion,revision) VALUES (?,?,?,'running','work','work',?,?,?,?,?,?,'1.0.0',0)").run(executionId,chosenId,owner,context,visits,now,now,now,taskTitle);
        })();
        if(db.pragma('quick_check',{simple:true})!=='ok') throw new Error('Fixture integrity failed');
        console.log(chosenId); db.close();
      `,
        JSON.stringify({ owner, prefix, executionId, taskTitle }),
      ]);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login(page, email, password);
      await page.goto(`${baseUrl}/overview`);
      const card = page.locator(`[data-testid="overview-card"][data-run-id="${executionId}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(taskTitle);
      await expect(card).toContainText(chosenName);
      await page.getByTestId("overview-filters").click();
      const trigger = page.getByTestId("overview-filter-flow");
      await expect(trigger).toBeVisible();
      await trigger.click();
      const options = page.getByRole("option");
      await expect(page.getByRole("option", { name: chosenName, exact: true })).toBeAttached();
      // Exact end-to-end membership, not merely a third HTTP request or one successful choice.
      const labels = await options.allTextContents();
      expect(
        labels
          .map((label) => label.trim())
          .filter((label) => label.startsWith("Chooser flow "))
          .sort(),
      ).toEqual(
        Array.from({ length: 205 }, (_, index) => `Chooser flow ${String(index).padStart(3, "0")}`),
      );
      expect(requests.map((request) => request.offset)).toEqual(
        expect.arrayContaining([0, 100, 200]),
      );
      expect(requests.every((request) => request.limit === 100)).toBe(true);
      await page.locator('[data-slot="command-input"]').fill(chosenName);
      const choice = page.getByRole("option", { name: chosenName, exact: true });
      await expect(choice).toBeVisible();
      // A wider sibling sort label must not widen the chooser's grid track and clip its options.
      await expect
        .poll(() =>
          page
            .getByTestId("overview-filters-popover")
            .evaluate((element) => element.scrollWidth - element.clientWidth),
        )
        .toBe(0);
      await expect(choice).toBeInViewport({ ratio: 1 });
      const filteredResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/executions/overview" &&
          url.searchParams.get("workflowId") === chosenId
        );
      });
      await choice.click();
      expect((await filteredResponse).status()).toBe(200);
      await expect(trigger).toHaveText(chosenName);
      await expect(page).toHaveURL(new RegExp(`workflowId=${chosenId}`));
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("overview-filters-popover")).toHaveCount(0);
      await expect(card).toBeVisible();
      await expect(page.getByTestId("overview-card")).toHaveCount(1);
      await expect(card).toContainText(taskTitle);
      await expect(card).toContainText(chosenName);
      // Every control remains reachable inside the bounded popover, even at the mobile edge.
      await page.getByTestId("overview-filters").click();
      const popover = page.getByTestId("overview-filters-popover");
      await expect(popover).toBeInViewport({ ratio: 1 });
      await popover.locator("summary").click();
      await expect
        .poll(() => popover.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      const sort = page.getByTestId("overview-filter-sort");
      await sort.scrollIntoViewIfNeeded();
      await expect(sort).toBeInViewport({ ratio: 1 });
      await sort.click();
      await expect(page.getByRole("option", { name: "newest first", exact: true })).toBeInViewport({
        ratio: 1,
      });
      await page.keyboard.press("Escape");
      const reset = page.getByTestId("overview-filters-reset");
      await reset.scrollIntoViewIfNeeded();
      await expect(reset).toBeInViewport({ ratio: 1 });
      await reset.click();
      await expect(page).not.toHaveURL(/workflowId=|period=|idle=|activeFrom=|activeTo=|q=|page=/);
      await expect(page.getByTestId("overview-period")).toHaveText("Last 7 days");
    } finally {
      dockerExecSync([
        "node",
        "--input-type=commonjs",
        "-e",
        `
        const db=new (require('better-sqlite3'))('/app/data/moira.db');
        db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
        const {owner,prefix,executionId}=JSON.parse(process.argv[1]);
        db.transaction(()=>{
          db.prepare('DELETE FROM workflowExecution WHERE executionId=? AND userId=?').run(executionId,owner);
          db.prepare('DELETE FROM workflow WHERE userId=? AND slug LIKE ?').run(owner,prefix+'-%');
        })(); db.close();
      `,
        JSON.stringify({ owner, prefix, executionId }),
      ]);
    }
  });
}
