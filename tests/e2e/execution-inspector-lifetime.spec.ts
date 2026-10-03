/** Actual owner stream, BrowserRouter parameter change and late detail response, without reload. */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { login } from "./helpers/auth-helper.js";
import { createTestUserViaApi } from "../utils/mcp-auth.js";
import { dockerExecSync } from "../utils/docker-command.js";
import { getTestBaseUrl, getTestFetchUrl, isExternalTarget } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();

test("a real route change drops A's delayed live detail and answers the currently displayed B", async ({
  page,
}, testInfo) => {
  const target = new URL(baseUrl);
  if (
    isExternalTarget() ||
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.port !== process.env.DOCKER_PORT ||
    new URL(getTestFetchUrl()).origin !== target.origin ||
    !process.env.DOCKER_CONTAINER_NAME ||
    process.env.PLAYWRIGHT_REMOTE === "true"
  )
    throw new Error(
      "Browser, HTTP helper and explicit isolated local Docker target must agree before fixture writes",
    );

  const prefix = `inspector-lifetime-${randomUUID()}`;
  const password = "Inspector-Lifetime-Password1!";
  const email = `${prefix}@example.test`;
  const owner = (await createTestUserViaApi(baseUrl, email, password, "Inspector Lifetime Owner"))
    .userId;
  const workflowId = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const aTitle = "Inspect task A inputs";
  const bTitle = "Inspect task B inputs";
  const renamedA = "Inspect task A inputs and credits";
  const fixture = { owner, prefix, workflowId, a, b, aTitle, bTitle };
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured: { executionId: string; taskTitle: string } | null = null;
  try {
    dockerExecSync([
      "node",
      "--input-type=commonjs",
      "-e",
      `
      const db=new(require('better-sqlite3'))('/app/data/moira.db');
      db.pragma('busy_timeout=5000');db.pragma('foreign_keys=ON');
      const f=JSON.parse(process.argv[1]);
      if(!db.prepare('SELECT id FROM user WHERE id=?').get(f.owner))throw new Error('Fixture owner missing on selected container');
      const now=Date.now();
      const graph={metadata:{name:'Inspector lifetime flow',description:'Two owned runs with the same waiting schema',version:'1.0.0'},variableRegistry:{marker:{type:'string',description:'Own-run context marker'}},nodes:[{id:'start',type:'start',connections:{default:'work'}},{id:'work',type:'agent-directive',metadata:{displayName:'Inspect inputs'},directive:'Inspect the current inputs',completionCondition:'Inspected',inputSchema:{type:'object',properties:{result:{type:'string'}},required:['result']},connections:{success:'end'}},{id:'end',type:'end'}]};
      db.transaction(()=>{
        db.prepare('INSERT INTO workflow (id,userId,slug,name,description,version,graph,visibility,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(f.workflowId,f.owner,f.prefix,graph.metadata.name,graph.metadata.description,'1.0.0',JSON.stringify(graph),'private',now,now);
        for(const [id,title,marker]of[[f.a,f.aTitle,'A-context'],[f.b,f.bTitle,'B-context']]){
          const context=JSON.stringify({variables:{marker},nodeStates:{},executionId:id,workflowId:f.workflowId,userId:f.owner});
          const visits=JSON.stringify([{seq:0,nodeId:'work',exitKey:null,changes:{},enteredAt:now,waited:true}]);
          const identity=JSON.stringify({title,changedAt:now,changeId:'fixture-'+id});
          db.prepare("INSERT INTO workflowExecution (executionId,workflowId,userId,state,currentNodeId,waitingForInputNodeId,context,visits,createdAt,updatedAt,lastActivityAt,workflowVersion,revision,taskIdentity) VALUES (?,?,?,'running','work','work',?,?,?,?,?,'1.0.0',0,?)").run(id,f.workflowId,f.owner,context,visits,now,now,now,identity);
        }
      })();db.close();`,
      JSON.stringify(fixture),
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, email, password);
    const streamReady = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/executions/overview/stream" &&
        response.status() === 200,
    );
    await page.goto(`${baseUrl}/executions/${a}`);
    await streamReady;
    await expect(page.getByTestId("run-task-title")).toHaveText(aTitle);
    await expect(page.locator('[data-variable="marker"]')).toHaveAttribute(
      "data-value",
      "A-context",
    );

    // Delay only the next real A detail response. All bodies, progress, events and mutations
    // come from the running application; no fabricated API or synthetic SSE is installed.
    const detailUrl = `${baseUrl}/api/executions/${a}`;
    await page.route(detailUrl, async (route) => {
      const response = await route.fetch();
      const execution = (await response.json()).data.execution;
      captured = { executionId: execution.executionId, taskTitle: execution.taskTitle };
      await released;
      await route.fulfill({ response });
    });
    const before = await page.request.get(detailUrl);
    expect(before.status()).toBe(200);
    const current = (await before.json()).data.execution;
    const rename = await page.request.put(`${detailUrl}/task-title`, {
      data: {
        taskTitle: renamedA,
        expectedRevision: current.revision,
        expectedTaskIdentityRevision: current.metadataRevisions.taskIdentity,
      },
    });
    expect(rename.status()).toBe(200);
    await expect.poll(() => captured).toMatchObject({ executionId: a, taskTitle: renamedA });

    const documentToken = await page.evaluate(() => {
      const token = crypto.randomUUID();
      document.documentElement.dataset.inspectorLifetimeDocument = token;
      return token;
    });
    const bLoaded = page.waitForResponse(
      (response) =>
        response.url() === `${baseUrl}/api/executions/${b}` && response.status() === 200,
    );
    await page.evaluate((id) => {
      history.pushState(null, "", `/executions/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, b);
    await bLoaded;
    await expect(page).toHaveURL(`${baseUrl}/executions/${b}`);
    await expect(page.getByTestId("run-task-title")).toHaveText(bTitle);
    await expect(page.locator('[data-variable="marker"]')).toHaveAttribute(
      "data-value",
      "B-context",
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.inspectorLifetimeDocument),
    ).toBe(documentToken);

    const lateResponse = page.waitForResponse(
      (response) => response.url() === detailUrl && response.status() === 200,
    );
    release();
    await (await lateResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await testInfo.attach("route-after-late-response", {
      body: JSON.stringify({
        a,
        b,
        expectedTitle: bTitle,
        url: page.url(),
        captured,
        displayedTitle: await page.getByTestId("run-task-title").textContent(),
        displayedContext: await page.locator('[data-variable="marker"]').getAttribute("data-value"),
        sameDocument:
          (await page.evaluate(
            () => document.documentElement.dataset.inspectorLifetimeDocument,
          )) === documentToken,
      }),
      contentType: "application/json",
    });
    await expect(page.getByTestId("run-task-title")).toHaveText(bTitle);
    await expect(page.locator('[data-variable="marker"]')).toHaveAttribute(
      "data-value",
      "B-context",
    );
    await expect(page).toHaveURL(`${baseUrl}/executions/${b}`);

    const mutations: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/executions\/[^/]+\/answer$/.test(new URL(request.url()).pathname)
      )
        mutations.push(request.url());
    });
    await page.getByTestId("answer-field-result").fill("Verified B inputs");
    const answer = page.waitForResponse(
      (response) =>
        response.url() === `${baseUrl}/api/executions/${b}/answer` &&
        response.request().method() === "POST",
    );
    await page.getByTestId("answer-submit").click();
    expect((await answer).status()).toBe(200);
    expect(mutations).toEqual([`${baseUrl}/api/executions/${b}/answer`]);
    const afterA = await page.request.get(detailUrl);
    const afterB = await page.request.get(`${baseUrl}/api/executions/${b}`);
    expect((await afterA.json()).data.execution.status).toBe("running");
    expect((await afterB.json()).data.execution.status).toBe("completed");
    await testInfo.attach("actual-route-lifetime", {
      body: JSON.stringify({ a, b, captured, documentToken, mutations }),
      contentType: "application/json",
    });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    const remaining = dockerExecSync([
      "node",
      "--input-type=commonjs",
      "-e",
      `
      const db=new(require('better-sqlite3'))('/app/data/moira.db');
      db.pragma('busy_timeout=5000');db.pragma('foreign_keys=ON');const f=JSON.parse(process.argv[1]);
      db.transaction(()=>{
        db.prepare('DELETE FROM workflowExecution WHERE executionId IN (?,?) AND userId=?').run(f.a,f.b,f.owner);
        db.prepare('DELETE FROM workflow WHERE id=? AND userId=?').run(f.workflowId,f.owner);
        db.prepare('DELETE FROM user WHERE id=?').run(f.owner);
      })();
      console.log(db.prepare('SELECT count(*) AS n FROM workflowExecution WHERE executionId IN (?,?)').get(f.a,f.b).n);db.close();`,
      JSON.stringify(fixture),
    ]);
    expect(remaining).toBe("0");
  }
});
