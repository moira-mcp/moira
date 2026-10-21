const { test, expect } = require("@jest/globals");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { writeFileSync, readFileSync, readdirSync, renameSync, mkdirSync } = require("node:fs");
const { createFixture, dispose } = require("../../fixtures/workspace-service.cjs");

const daemon = pathToFileURL(resolve("packages/workspace-service/src/daemon.mjs")).href;
const engine = pathToFileURL(resolve("packages/workspace-service/src/engine.mjs")).href;
async function child(f, config, script) {
  const process = spawn(global.process.execPath, ["--import", "tsx", "--input-type=module"], {
    cwd: global.process.cwd(),
    env: { PATH: "/usr/bin:/bin", HOME: f.directory, MOIRA_ENVIRONMENT_ID: "coldboot-fixture" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [],
    errors = [];
  process.stdout.on("data", (bytes) => output.push(bytes));
  process.stderr.on("data", (bytes) => errors.push(bytes));
  const ended = once(process, "close");
  process.stdin
    .end(`import fs from 'node:fs';import path from 'node:path';import {renewWorkspaceConfiguration} from ${JSON.stringify(daemon)};import {createWorkspaceEngine} from ${JSON.stringify(engine)};
    const config=${JSON.stringify(config)}, state=path.join(process.env.HOME,'.local/state/moira/workspace-service');
    const currentLife=await createWorkspaceEngine({stateRoot:state,binding:config.binding}).environmentIdentity();
    ${script}`);
  const [code] = await ended;
  if (code !== 0) throw new Error(Buffer.concat(errors).toString());
  return JSON.parse(Buffer.concat(output).toString());
}
function config(f) {
  return {
    version: 1,
    binding: f.binding,
    environmentIdentity: "a".repeat(64),
    releaseIdentity: "b".repeat(64),
    github: { repositoryFullName: "owner/project" },
    remote: {
      version: 1,
      origin: "https://moira.example",
      publicOrigin: "https://moira.example",
      resourceId: randomUUID(),
      resourceGeneration: 1,
      authorizationGeneration: 1,
      environmentIdentity: "a".repeat(64),
      credential: "c".repeat(43),
    },
    renewal: { credential: "r".repeat(43) },
  };
}
test("cold boot retains a token-free original enrollment request across lost reply and restart without touching workspace data", async () => {
  const f = createFixture(),
    input = config(f);
  const configuration = join(f.directory, ".local/share/moira-workspace/config.json");
  const installed = JSON.stringify(input);
  mkdirSync(join(f.directory, ".local/share/moira-workspace"), { recursive: true, mode: 0o700 });
  writeFileSync(configuration, installed, { mode: 0o600 });
  writeFileSync(join(f.root, "sentinel"), "owned workspace data");
  try {
    const lost = await child(
      f,
      input,
      `let submitted=false,original;
      globalThis.fetch=async(url,options)=>{submitted=true;original=JSON.parse(options.body);const durable=JSON.parse(fs.readFileSync(path.join(state,'renewal-'+currentLife+'.json'),'utf8'));if(JSON.stringify(durable)!==JSON.stringify(original))throw Error('not durable');throw Error('lost reply')};
      let refused=false;try{await renewWorkspaceConfiguration(config,config.releaseIdentity)}catch{refused=true}
      console.log(JSON.stringify({submitted,refused,requestId:original.requestId}));`,
    );
    expect(lost.submitted).toBe(true);
    expect(lost.refused).toBe(true);
    expect(readFileSync(configuration, "utf8")).toBe(installed);
    const recovered = await child(
      f,
      input,
      `let requestId,called=0;
      globalThis.fetch=async(url,options)=>{called++;const body=JSON.parse(options.body);requestId=body.requestId;if(String(url)!=='https://moira.example/api/codespaces/github/resources/'+config.remote.resourceId+'/renew-enrollment'||options.headers.authorization!=='Bearer '+config.renewal.credential)throw Error('wrong authority');return {status:200,json:async()=>({...config.remote,environmentIdentity:currentLife,credential:'n'.repeat(43),renewal:config.renewal})}};
      const next=await renewWorkspaceConfiguration(config,config.releaseIdentity);
      const saved=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.local/share/moira-workspace/config.json'),'utf8'));
      console.log(JSON.stringify({called,requestId,currentLife,configuredLife:saved.environmentIdentity,renewalStable:next.renewal.credential===config.renewal.credential}));`,
    );
    expect(recovered.called).toBe(1);
    expect(recovered.requestId).toBe(lost.requestId);
    expect(recovered.configuredLife).toBe(recovered.currentLife);
    expect(recovered.renewalStable).toBe(true);
    const records = readdirSync(join(f.directory, ".local/state/moira/workspace-service")).filter(
      (name) => name.startsWith("renewal-"),
    );
    expect(records).toHaveLength(1);
    const receipt = readFileSync(
      join(f.directory, ".local/state/moira/workspace-service", records[0]),
      "utf8",
    );
    expect(receipt).not.toContain(input.renewal.credential);
    expect(receipt).not.toContain(input.remote.credential);
    expect(readFileSync(join(f.root, "sentinel"), "utf8")).toBe("owned workspace data");
  } finally {
    await dispose(f);
  }
});
test("a replaced cold boot repository root refuses before sending its retained enrollment capability", async () => {
  const f = createFixture(),
    input = config(f);
  try {
    renameSync(f.root, join(f.directory, "original-root"));
    mkdirSync(f.root);
    const result = await child(
      f,
      input,
      `let submitted=false,refused=false;globalThis.fetch=async()=>{submitted=true;throw Error('unexpected effect')};try{await renewWorkspaceConfiguration(config,config.releaseIdentity)}catch{refused=true};console.log(JSON.stringify({submitted,refused}));`,
    );
    expect(result).toEqual({ submitted: false, refused: true });
  } finally {
    await dispose(f);
  }
});
