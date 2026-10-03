/** Real HTTP latency on the same bounded workload as the service baseline. */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerExecSync } from "../utils/docker-command.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";
import { getTestBaseUrl, isExternalTarget } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const workflowId = randomUUID();
const privateWorkflowId = randomUUID();
const prefix = `overview-perf-${randomUUID()}`;
const password = "Overview-Performance-1!";
const now = Date.now();
let owner: string;
let outsider: string;
let cookie: string;

interface Run {
  executionId: string;
  children: { total: number };
  childRuns: Run[];
  stages: { labels: string[] };
  list: { items: unknown[]; total: number; done: number };
}
function flatten(rows: Run[]): Run[] {
  return rows.flatMap((row) => [row, ...flatten(row.childRuns)]);
}

const graph = {
  metadata: {
    name: "Synthetic task batch",
    description: "Fixed overview benchmark",
    version: "1.0.0",
  },
  progress: {
    title: "{{task_name}}",
    nodes: [
      {
        id: "work",
        label: "Process tasks",
        content: { summary: "Process the synthetic list" },
        list: { items: "tasks", current: "task_index", title: "title" },
      },
      { id: "check", label: "Check results", content: { summary: "Verify output" } },
    ],
  },
  nodes: [
    { type: "start", id: "start", progressNodeId: "work", connections: { default: "task" } },
    {
      type: "agent-directive",
      id: "task",
      progressNodeId: "work",
      directive: "Process task",
      completionCondition: "Task processed",
      connections: { success: "task", complete: "check" },
      connectionLabels: {
        success: { label: "Next task", cycle: { cause: "Tasks remain", exit: "All processed" } },
        complete: "List processed",
      },
    },
    {
      type: "agent-directive",
      id: "check",
      progressNodeId: "check",
      directive: "Verify results",
      completionCondition: "Verified",
      connections: { success: "end" },
      connectionLabels: { success: "Verified" },
    },
    { type: "end", id: "end", progressNodeId: "check" },
  ],
};

describe("bounded overview HTTP workload", () => {
  beforeAll(async () => {
    if (isExternalTarget())
      throw new Error("Synthetic performance fixtures require an isolated local container");
    if (new URL(baseUrl).port !== process.env.DOCKER_PORT || !process.env.DOCKER_CONTAINER_NAME) {
      throw new Error(
        "HTTP target and explicit Docker fixture environment must agree before creating users",
      );
    }
    const email = `${prefix}@example.test`;
    owner = (await createTestUserViaApi(baseUrl, email, password, "Performance Owner")).userId;
    outsider = (
      await createTestUserViaApi(baseUrl, `${prefix}-other@example.test`, password, "Other Owner")
    ).userId;
    cookie = await signInUser(baseUrl, email, password);
    // Construct bulky values inside the container: no host DB/WAL replacement or oversized argv.
    dockerExecSync([
      "node",
      "--input-type=commonjs",
      "-e",
      `
      const Database=require('better-sqlite3');
      const db=new Database('/app/data/moira.db');
      db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
      const {owner,outsider,workflowId,privateWorkflowId,prefix,now,graph}=JSON.parse(process.argv[1]);
      const insert=db.prepare("INSERT INTO workflowExecution (executionId,workflowId,userId,state,currentNodeId,waitingForInputNodeId,context,visits,createdAt,updatedAt,lastActivityAt,parentExecutionId,note,revision,workflowVersion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,'1.0.0')");
      const visits=Array.from({length:500},(_,seq)=>({seq,nodeId:'task',exitKey:seq===499?null:'success',changes:{task_index:seq+1},enteredAt:now-500000+seq*1000,...(seq===499?{waited:true}:{leftAt:now-500000+seq*1000+900})}));
      const tasks=Array.from({length:600},(_,i)=>({title:'Synthetic task '+(i+1)}));
      db.transaction(()=>{
        db.prepare('INSERT INTO workflow (id,userId,slug,name,description,version,graph,visibility,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(workflowId,owner,prefix,graph.metadata.name,graph.metadata.description,'1.0.0',JSON.stringify(graph),'private',now-30*86400000,now);
        db.prepare('INSERT INTO workflow (id,userId,slug,name,description,version,graph,visibility,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(privateWorkflowId,outsider,prefix,graph.metadata.name,graph.metadata.description,'1.0.0',JSON.stringify(graph),'private',now-30*86400000,now);
        for(let i=0;i<2000;i++) {
          const selected=i<60, id=prefix+'-'+String(i).padStart(4,'0');
          const userId=i===1999?outsider:owner;
          const parent=i>=50&&i<60?prefix+'-'+String(i-50).padStart(4,'0'):null;
          const context=JSON.stringify({variables:selected?{task_name:'Batch '+i,task_index:500,tasks,unused_blob:'x'.repeat(256*1024)}:{},nodeStates:{},executionId:id,workflowId,userId});
          insert.run(id,workflowId,userId,selected||i===1999?'running':'completed','task',selected?'task':null,context,selected?JSON.stringify(visits):'[]',now-30*86400000+i,selected?now-i*1000:now-20*86400000,selected?now-i*1000:now-20*86400000,parent,'Batch '+i);
        }
      })();
      if(db.pragma('quick_check',{simple:true})!=='ok') throw new Error('Fixture integrity failed');
      db.close();
    `,
      JSON.stringify({ owner, outsider, workflowId, privateWorkflowId, prefix, now, graph }),
    ]);
  });

  afterAll(() => {
    if (!owner) return;
    dockerExecSync([
      "node",
      "--input-type=commonjs",
      "-e",
      `
      const db=new (require('better-sqlite3'))('/app/data/moira.db');
      db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
      db.transaction(()=>{
        db.prepare('DELETE FROM workflowExecution WHERE workflowId=?').run(process.argv[1]);
        db.prepare('DELETE FROM workflow WHERE id=?').run(process.argv[1]);
        db.prepare('DELETE FROM workflow WHERE id=?').run(process.argv[2]);
      })(); db.close();
    `,
      workflowId,
      privateWorkflowId,
    ]);
  });

  test.each([
    [
      "overview",
      (): string => `/api/executions/overview?status=active&limit=50&workflowId=${workflowId}`,
      500,
    ],
    ["detail", (): string => `/api/executions/overview?ids=${prefix}-0000`, 200],
    ["progress-detail", (): string => `/api/executions/${prefix}-0000/progress`, 200],
    ["chooser", (): string => `/api/workflows?access=mine&limit=100&sort=name&sortOrder=asc`, 500],
  ] as const)(
    "%s retains complete authorized progress within its HTTP P95 budget",
    async (kind, path, budget) => {
      const samples: number[] = [];
      const responseBytes: number[] = [];
      let firstRequestMs = 0;
      for (let sample = 0; sample < 34; sample++) {
        const start = performance.now();
        const response = await fetch(`${baseUrl}${path()}`, {
          headers: { Cookie: formatSessionCookie(baseUrl, cookie) },
        });
        const text = await response.text();
        const elapsed = performance.now() - start;
        expect(response.status).toBe(200);
        const data = JSON.parse(text).data;
        if (kind === "chooser") {
          expect(data.workflows.map((flow: { id: string }) => flow.id)).toEqual([workflowId]);
          expect(data.totalWorkflows).toBe(1);
        } else if (kind === "progress-detail") {
          expect(data.taskTitle).toBe("Batch 0");
          expect(data.nodes).toHaveLength(2);
          expect(data.nodes[0].list.items).toHaveLength(600);
          expect(data.nodes[0].list.done).toBe(499);
        } else {
          const rows = flatten(data.runs);
          expect(data.runs).toHaveLength(kind === "overview" ? 50 : 1);
          expect(rows).toHaveLength(kind === "overview" ? 60 : 1);
          if (kind === "overview") expect(data.total).toBe(50);
          expect(
            rows.every(
              (row) => row.executionId.startsWith(prefix) && !row.executionId.endsWith("-1999"),
            ),
          ).toBe(true);
          for (const row of rows) {
            expect(row.stages.labels).toHaveLength(2);
            expect(row.list.items).toHaveLength(5);
            expect(row.list.total).toBe(600);
            expect(row.list.done).toBe(499);
          }
          expect(data.runs[0].children.total).toBe(1);
        }
        if (sample === 0) firstRequestMs = elapsed;
        if (sample >= 4) {
          samples.push(elapsed);
          responseBytes.push(Buffer.byteLength(text));
        }
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      const evidence = {
        kind,
        runtime: process.version,
        fixture: {
          rows: 2000,
          selectedRoots: 50,
          selectedRows: 60,
          visitsPerSelected: 500,
          unusedBytesPerSelected: 262144,
        },
        firstRequestMs,
        warmupRequests: 3,
        samples,
        sampleCount: samples.length,
        medianMs: sorted[15],
        p95Ms: p95,
        budgetMs: budget,
        responseBytes,
      };
      const directory = join(
        process.cwd(),
        "agent_temp_files_local",
        "http-performance",
        process.env.OVERVIEW_PERF_EDITION || "current",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${kind}.json`), JSON.stringify(evidence, null, 2));
      console.log(
        JSON.stringify({ ...evidence, samples: undefined, responseBytes: responseBytes[0] }),
      );
      expect(samples).toHaveLength(30);
      expect(p95).toBeLessThanOrEqual(budget);
    },
  );
});
