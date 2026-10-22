import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { build } from "esbuild";
import sharp from "sharp";
import tar from "tar-stream";
import { createWorkspaceRequestId } from "../packages/shared/src/codespaces/workspace-request-id.ts";
import { decodeReference } from "../packages/shared/src/codespaces/workspace-references.mjs";
import { encodeOwnerFrame } from "../packages/shared/src/http/owner-stream-frame.mjs";
import {
  DAEMON_DIAGNOSTIC_FILE_BYTES,
  DAEMON_DIAGNOSTIC_FILE_COUNT,
} from "../packages/workspace-service/src/daemon-diagnostics.mjs";
import {
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
  WORKSPACE_GITHUB_PROOF_SCRIPT,
  loadWorkspacePayload,
  workspaceInstallInput,
} from "../packages/workspace-service/src/bootstrap.mjs";
import { DEFAULT_TEMPLATE } from "../packages/local/dist/config.js";
import { sdfWorkflow, sdfExecution } from "../tests/helpers/sdf-progress-fixture.ts";
import { compileBinaryExtensionArtifact } from "../packages/extension-runner/src/binary-artifact.ts";
import { scanExtensionBundles } from "../packages/extension-runner/src/bundle-loader.ts";

function docker(argv, input) {
  const caller = new Error("Guest verification invocation").stack;
  return new Promise((done, failed) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [],
      stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", failed);
    child.once("close", (code) => {
      if (code === 0) return done(Buffer.concat(stdout));
      const safe = {};
      try {
        const value = JSON.parse(Buffer.concat(stdout).toString("utf8")).structuredContent;
        const errorCode = value?.error?.code ?? value?.outcome?.error?.code;
        if (/^[A-Z][A-Z0-9_]{1,79}$/.test(errorCode ?? "")) safe.code = errorCode;
        if (["absent", "pending", "unconfirmed", "completed"].includes(value?.state))
          safe.state = value.state;
        const reason = value?.error?.reason ?? value?.outcome?.result?.reason;
        if (["unsafe_access", "concurrent_change", "precondition"].includes(reason))
          safe.reason = reason;
      } catch {
        // Failed stdout may contain owned bytes; never dump it as diagnostics.
      }
      const cli = argv.findIndex((argument) => argument.endsWith("/moira-workspace"));
      const daemon = argv.findIndex((argument) => argument.endsWith("/service/daemon.mjs"));
      const stage =
        cli >= 0
          ? `workspace CLI ${argv[cli + 1]}`
          : daemon >= 0
            ? `workspace daemon ${argv[daemon + 1]}`
            : `${argv[0]} guest fixture`;
      const error = new Error(
        `Guest verification ${stage} exit ${code}: ${JSON.stringify(safe)} ${Buffer.concat(stderr)}`,
      );
      error.stack += `\n${caller}`;
      failed(error);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") failed(error);
    });
    if (input && Symbol.asyncIterator in Object(input)) {
      void (async () => {
        try {
          for await (const bytes of input)
            await new Promise((accept, reject) =>
              child.stdin.write(bytes, (error) => (error ? reject(error) : accept())),
            );
          child.stdin.end();
        } catch (error) {
          child.kill();
          failed(error);
        }
      })();
    } else child.stdin.end(input);
  });
}

const payload = await loadWorkspacePayload(
  resolve("packages/workspace-service/dist"),
  process.arch,
);
let container;
let fixtureDirectory;
const ownedVolumes = [];
let activeHome = "/home/agent";
verification: try {
  await mkdir(resolve("agent_temp_files_local"), { recursive: true });
  fixtureDirectory = await mkdtemp(resolve("agent_temp_files_local/guest-router-"));
  const keyPath = `${fixtureDirectory}/key.pem`,
    caPath = `${fixtureDirectory}/ca.pem`;
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    caPath,
  ]);
  await docker(["image", "inspect", DEFAULT_TEMPLATE, "--format", "{{.Id}}"]);
  for (const role of ["home", "repositories"]) {
    const name = `moira-guest-${role}-${randomUUID()}`;
    await docker(["volume", "create", name]);
    ownedVolumes.push(name);
  }
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "--mount",
    `type=volume,src=${ownedVolumes[0]},dst=/owned-home`,
    "--mount",
    `type=volume,src=${ownedVolumes[1]},dst=/owned-repositories`,
    "--entrypoint",
    "/bin/sh",
    DEFAULT_TEMPLATE,
    "-c",
    "chown 1000:1000 /owned-home /owned-repositories; chmod 700 /owned-home /owned-repositories",
  ]);
  container = (
    await docker([
      "run",
      "--detach",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--env",
      "HOME=/home/agent",
      "--env",
      "NODE_EXTRA_CA_CERTS=/tmp/owner-ca.pem",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--mount",
      `type=volume,src=${ownedVolumes[1]},dst=/workspaces`,
      "--mount",
      `type=volume,src=${ownedVolumes[0]},dst=/home/agent`,
      "--entrypoint",
      "/bin/sh",
      DEFAULT_TEMPLATE,
      "-c",
      "exec tail -f /dev/null",
    ])
  )
    .toString()
    .trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const fixed = (script, input) =>
    docker(
      ["exec", "--interactive", "--env", `HOME=${activeHome}`, container, "/bin/sh", "-c", script],
      input,
    );
  const installed = JSON.parse(
    await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload)),
  );
  assert.equal(installed.releaseIdentity, payload.release);
  const program = `/home/agent/.local/share/moira-workspace/releases/${payload.release}`;
  const node = `${program}/runtime/bin/node`;
  const directoryPublication = await build({
    stdin: {
      contents: `
        import assert from 'node:assert/strict';
        import {mkdir,writeFile,readFile,symlink,lstat,rename} from 'node:fs/promises';
        import {publishDirectoryNoReplace,openDirectory,directoryIdentity} from ${JSON.stringify(resolve("packages/workspace-service/src/file-primitives.mjs"))};
        import {verifyGuestSetupRecovery} from ${JSON.stringify(resolve("tests/helpers/guest-setup-recovery.ts"))};
        const root='/workspaces/directory-publication';await mkdir(root,{mode:448});
        const parent=await openDirectory(root);
        try{
          for(const kind of ['absent','empty','nonempty','file','symlink']){
            const stageName='stage-'+kind,targetName='target-'+kind;
            await mkdir(root+'/'+stageName);await writeFile(root+'/'+stageName+'/sentinel','owned-stage');
            if(kind==='empty'||kind==='nonempty')await mkdir(root+'/'+targetName);
            if(kind==='nonempty')await writeFile(root+'/'+targetName+'/user-content','preserved');
            if(kind==='file')await writeFile(root+'/'+targetName,'preserved');
            if(kind==='symlink')await symlink(stageName,root+'/'+targetName);
            const before=kind==='absent'?null:await lstat(root+'/'+targetName);
            const stage=await openDirectory(root,stageName);
            try{
              const expected=await directoryIdentity(stage);
              if(kind==='absent'){
                assert.deepEqual(await publishDirectoryNoReplace(parent,stageName,targetName,stage),expected);
                const published=await openDirectory(root,targetName);
                try{assert.deepEqual(await directoryIdentity(published),expected);}finally{await published.close();}
                assert.equal(await readFile(root+'/'+targetName+'/sentinel','utf8'),'owned-stage');
              }else{
                await assert.rejects(publishDirectoryNoReplace(parent,stageName,targetName,stage),error=>error.fileReason==='concurrent_change');
                const after=await lstat(root+'/'+targetName);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
                assert.equal(await readFile(root+'/'+stageName+'/sentinel','utf8'),'owned-stage');
                if(kind==='nonempty')assert.equal(await readFile(root+'/'+targetName+'/user-content','utf8'),'preserved');
                if(kind==='file')assert.equal(await readFile(root+'/'+targetName,'utf8'),'preserved');
              }
            }finally{await stage.close();}
          }
          await mkdir(root+'/changed-stage');const held=await openDirectory(root,'changed-stage');
          try{await rename(root+'/changed-stage',root+'/original-stage');await mkdir(root+'/changed-stage');
            await assert.rejects(publishDirectoryNoReplace(parent,'changed-stage','not-published',held),error=>error.fileReason==='concurrent_change');
            await assert.rejects(lstat(root+'/not-published'),{code:'ENOENT'});
          }finally{await held.close();}
        }finally{await parent.close();}
        console.log('Linux exclusive directory publication preserves occupied targets and refuses a replaced stage');
        await verifyGuestSetupRecovery('/workspaces/setup-recovery-proof');
        console.log('Linux setup recovery preserves original stage, published inode, sentinels and user branch');
      `,
      resolveDir: process.cwd(),
      sourcefile: "directory-publication-fixture.mjs",
      loader: "js",
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
  });
  await docker(
    ["exec", "--interactive", container, node, "--input-type=module"],
    directoryPublication.outputFiles[0].contents,
  );
  // Execute the shipped renderer, with its private native modules and fonts. A
  // callback backed by the checkout's Sharp cannot satisfy this observation.
  const progressGraph = sdfWorkflow();
  const progressStart = progressGraph.nodes.find((entry) => entry.type === "start");
  assert.ok(progressStart, "Bundled progress fixture has no start node");
  const renderedProgress = await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "--input-type=module",
      "-e",
      "const {renderOwnerProgress}=await import(process.argv[1]);let input='';for await(const chunk of process.stdin)input+=chunk;const descriptor=JSON.parse(input);const bytes=await renderOwnerProgress(descriptor,{cacheRoot:'/tmp/owner-renderer-cache'});process.stdout.write(bytes);",
      `file://${program}/service/owner-renderer.mjs`,
    ],
    JSON.stringify({
      kind: "steps",
      graph: progressGraph,
      run: sdfExecution(progressGraph, progressStart.id),
      renderContext: { runUrl: "https://moira.example/executions/owner-fixture" },
    }),
  );
  const progressMetadata = await sharp(renderedProgress).metadata();
  assert.equal(progressMetadata.format, "png");
  assert.equal(progressMetadata.width, 1170);
  assert.ok(progressMetadata.height > 0, "Packaged renderer returned an empty progress image");
  const cli = (...args) =>
    docker([
      "exec",
      "--interactive",
      "--env",
      `HOME=${activeHome}`,
      container,
      `${activeHome}/.local/bin/moira-workspace`,
      ...args,
    ]);
  const deliver = (method, path, body) =>
    docker(
      [
        "exec",
        "--interactive",
        container,
        node,
        "--input-type=module",
        "-e",
        "const {workspaceRequest}=await import(process.argv[1]);let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);const response=await workspaceRequest(input.socketPath,input.method,input.path,input.body===undefined?undefined:JSON.stringify(input.body),{'content-type':'application/json'});if(response.statusCode!==200)throw new Error('Packaged owner request refused');for await(const chunk of response)process.stdout.write(chunk);",
        `file://${program}/service/cli.mjs`,
      ],
      JSON.stringify({
        socketPath: `${activeHome}/.local/state/moira/workspace-service/service.sock`,
        method,
        path,
        body,
      }),
    ).then((value) => JSON.parse(value));
  const semantic = (action, request) => deliver("POST", "/v1/tools", { action, request });
  const semanticStream = (action, request, requestId, bytes) =>
    docker(
      [
        "exec",
        "--interactive",
        container,
        node,
        "--input-type=module",
        "-e",
        `const {workspaceRequest}=await import(process.argv[1]);const response=await workspaceRequest(${JSON.stringify(`${activeHome}/.local/state/moira/workspace-service/service.sock`)},'POST','/v1/tools',process.stdin,{'content-type':'application/vnd.moira.owner-stream'});for await(const chunk of response)process.stdout.write(chunk);`,
        `file://${program}/service/cli.mjs`,
      ],
      encodeOwnerFrame({ action, request, requestId }, [bytes]).body,
    ).then((value) => JSON.parse(value));
  await docker([
    "exec",
    container,
    "/bin/sh",
    "-c",
    "mkdir /workspaces/project; git init /workspaces/project; git -C /workspaces/project remote add origin https://github.com/owner/project.git",
  ]);
  const measured = JSON.parse(await fixed(WORKSPACE_PROBE_SCRIPT));
  const resourceId = randomUUID();
  const extensionBundle = scanExtensionBundles(
    resolve("tests/fixtures/extension-bundles"),
  ).bundles.find((bundle) => bundle.manifest.name === "channel-probe");
  assert.ok(extensionBundle, "Installed binary extension fixture is missing");
  const extensionArtifact = await compileBinaryExtensionArtifact(extensionBundle);
  // This disposable authority is confined to the fixture container. It exercises
  // the actual common-owner router, without provider/account or real-GitHub claims.
  const routerBundle = await build({
    stdin: {
      contents: `
      import {createServer} from 'node:https';
      import {readFile} from 'node:fs/promises';
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      import {once} from 'node:events';
      import {WorkspaceRouter} from ${JSON.stringify(resolve("packages/web-backend/src/services/workspace-router.ts"))};
      import {readOwnerFrame} from ${JSON.stringify(resolve("packages/shared/src/http/owner-stream-frame.mjs"))};
      const input=JSON.parse(await readFile('/tmp/router-input.json','utf8'));
      const binding={kind:'workspace',userId:input.resourceId,resourceId:input.resourceId,resourceGeneration:1,authorizationGeneration:1,environmentIdentity:input.environmentIdentity};
      let unavailable=true;
      const router=new WorkspaceRouter({credential:async credential=>{if(unavailable)throw new Error('Fixture authority store unavailable');if(credential!==input.credential)throw new Error('Fixture credential refused');return binding;},request:async(user,id)=>{if(user!==binding.userId||id!==binding.resourceId)throw new Error('Fixture principal refused');return binding;}});
      const observed={prepared:0,artifacts:0,sent:0,size:0,sha256:null};
      const server=createServer({key:await readFile('/tmp/owner-key.pem'),cert:await readFile('/tmp/owner-ca.pem')},async(request,response)=>{
        const json=value=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));};
        try {
          if(request.method==='POST'&&request.url==='/api/codespaces/github/resources/'+input.resourceId+'/renew-enrollment'){
            assert.equal(request.headers.authorization,'Bearer '+input.renewalCredential);
            let text='';for await(const chunk of request)text+=chunk;const proof=JSON.parse(text);
            const {writeFile}=await import('node:fs/promises');
            let original;try{original=JSON.parse(await readFile('/home/agent/renewal-observed.json','utf8'))}catch(error){if(error.code!=='ENOENT')throw error;}
            if(original)assert.deepEqual(proof,original);else await writeFile('/home/agent/renewal-observed.json',JSON.stringify(proof));
            try{await readFile('/home/agent/renewal-ready')}catch{response.writeHead(503).end();return;}
            input.credential='z'.repeat(43);binding.environmentIdentity=proof.environmentIdentity;unavailable=false;
            return json({version:1,origin:input.origin,publicOrigin:input.origin,resourceId:input.resourceId,resourceGeneration:1,authorizationGeneration:1,environmentIdentity:proof.environmentIdentity,credential:input.credential,renewal:{credential:input.renewalCredential}});
          }
          if(request.url==='/fixture/connected'){if(!router.isConnected(binding))await once(router,'connected');return json({connected:router.isConnected(binding)});}
          if(request.url==='/fixture/authority-ready'){unavailable=false;return json({available:true});}
          if(request.url==='/fixture/extension')return json(observed);
          assert.equal(request.headers.authorization,'Bearer '+input.credential);
          if(request.method==='GET'&&request.url==='/api/communication/owner/artifacts/channel-probe.notifications/'+input.extensionDigest){
            observed.artifacts++;
            response.writeHead(200,{'content-type':'application/octet-stream'});
            response.end(await readFile('/tmp/extension-artifact.json'));return;
          }
          if(request.method==='POST'&&request.url==='/api/communication/owner/prepare'){
            let text='';for await(const chunk of request)text+=chunk;
            const value=JSON.parse(text);
            assert.equal(value.scope.resourceId,input.resourceId);
            assert.equal(value.scope.environmentIdentity,input.environmentIdentity);
            assert.deepEqual(value.channelIds,['channel-probe.notifications']);
            observed.prepared++;
            return json({channels:[{channelId:'channel-probe.notifications',provider:'extension',capabilities:{text:true,image:true,document:true},operations:['upload'],authorityDigest:'a'.repeat(64),bundleDigest:input.extensionDigest,settings:{'channel-probe.enabled':true}}]});
          }
          if(request.method==='POST'&&request.url==='/api/communication/owner/send'){
            const frame=await readOwnerFrame(request);
            assert.equal(frame.control.scope.resourceId,input.resourceId);
            assert.equal(frame.control.bundleDigest,input.extensionDigest);
            assert.equal(frame.control.operationId,'upload');
            assert.deepEqual(frame.control.controls,{caption:'packaged custom binary'});
            const hash=createHash('sha256');let size=0;
            for await(const chunk of frame.body){size+=chunk.length;hash.update(chunk);}
            assert.equal(size,frame.control.file.size);
            observed.size=size;observed.sha256=hash.digest('hex');observed.sent++;
            return json({status:'delivered'});
          }
          response.writeHead(404);response.end();
        }catch{response.writeHead(500);response.end();}
      });
      router.attach(server);
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(input.port??0,'127.0.0.1',resolve);});
      process.on('SIGTERM',()=>{void router.close().then(()=>{server.closeAllConnections();server.close(()=>process.exit(0));});});
      process.send({ready:true,origin:'https://127.0.0.1:'+server.address().port,processId:process.pid});
    `,
      resolveDir: process.cwd(),
      sourcefile: "guest-router-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
  });
  const routerInput = {
    resourceId,
    environmentIdentity: measured.environmentIdentity,
    credential: "x".repeat(43),
    renewalCredential: "y".repeat(43),
    extensionDigest: extensionArtifact.digest,
  };
  const routerAssets = [
    ["/tmp/owner-key.pem", await readFile(keyPath)],
    ["/tmp/owner-ca.pem", await readFile(caPath)],
    ["/tmp/router.mjs", routerBundle.outputFiles[0].contents],
    ["/tmp/extension-artifact.json", extensionArtifact.bytes],
    ["/tmp/router-input.json", Buffer.from(JSON.stringify(routerInput))],
  ];
  const installRouterAssets = async () => {
    for (const [path, bytes] of routerAssets) {
      await docker(
        [
          "exec",
          "--interactive",
          container,
          node,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(path)},require('node:fs').readFileSync(0),{mode:384})`,
        ],
        bytes,
      );
    }
  };
  await installRouterAssets();
  const startRouter = async () =>
    JSON.parse(
      await docker([
        "exec",
        container,
        node,
        "-e",
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['/tmp/router.mjs'],{detached:true,stdio:['ignore','ignore','inherit','ipc']});child.once('error',()=>process.exit(1));child.once('exit',()=>process.exit(1));child.once('message',value=>{if(!value.ready)process.exit(1);process.stdout.write(JSON.stringify(value));child.disconnect();child.unref();});",
      ]),
    );
  const router = await startRouter();
  assert.ok(Number.isSafeInteger(router.processId) && router.processId > 1);
  // Missing configuration must fail the actual startup owner. A request to
  // start is not readiness, and offline health must settle without a waiter.
  assert.equal(
    JSON.parse(await fixed(WORKSPACE_START_SCRIPT)).workspaceService,
    "enrollment-required",
  );
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  const configuration = {
    version: 1,
    repositoryId: "1",
    resourceId,
    repositoryFullName: "owner/project",
    root: "/workspaces/project",
    ...JSON.parse(
      await fixed(
        WORKSPACE_GITHUB_PROOF_SCRIPT,
        JSON.stringify({ resourceId, repositoryId: "1", repositoryFullName: "owner/project" }),
      ),
    ),
    expectedRelease: payload.release,
    ownerSelector: { kind: "github", resourceId },
    renewal: { credential: routerInput.renewalCredential },
    remote: {
      version: 1,
      origin: router.origin,
      publicOrigin: router.origin,
      resourceId,
      resourceGeneration: 1,
      authorizationGeneration: 1,
      environmentIdentity: measured.environmentIdentity,
      credential: "x".repeat(43),
    },
  };
  await assert.rejects(
    fixed(
      WORKSPACE_CONFIGURE_SCRIPT,
      JSON.stringify({
        ...configuration,
        remote: { ...configuration.remote, origin: "http://moira.example.invalid" },
      }),
    ),
  );
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  const { remote: initialRemote, renewal: initialRenewal, ...withoutCredential } = configuration;
  await fixed(
    WORKSPACE_CONFIGURE_SCRIPT,
    JSON.stringify({ ...withoutCredential, mode: "local-only" }),
  );
  const ready = JSON.parse(await fixed(WORKSPACE_START_SCRIPT));
  assert.equal(ready.releaseIdentity, payload.release);
  assert.ok(Number.isSafeInteger(ready.processId) && ready.processId > 1);
  assert.notEqual(ready.remote.state, "connected");
  const offlineResult = JSON.parse(
    await cli("exec", "--", node, "-e", "process.stdout.write('ready-before-cloud')"),
  ).structuredContent;
  assert.equal(offlineResult.state, "completed");
  assert.equal(offlineResult.outcome.ok, true);
  assert.equal(offlineResult.stdout, "ready-before-cloud");
  const githubHeld = JSON.parse(
    await cli(
      "exec",
      "--background",
      "--",
      node,
      "-e",
      "const fs=require('node:fs');fs.appendFileSync('github-continuity','once\\n');fs.writeFileSync('github-ready','ready');const t=setInterval(()=>{if(fs.existsSync('github-release')){clearInterval(t);process.stdout.write('same-github-owner')}},10)",
    ),
  ).structuredContent;
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    "import {watch,existsSync} from 'node:fs';await new Promise(done=>{const watcher=watch('/workspaces/project',()=>{if(existsSync('/workspaces/project/github-ready')){watcher.close();done()}});if(existsSync('/workspaces/project/github-ready')){watcher.close();done()}})",
  ]);
  await fixed(
    WORKSPACE_CONFIGURE_SCRIPT,
    JSON.stringify({ ...withoutCredential, remote: initialRemote, renewal: initialRenewal }),
  );
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).processId, ready.processId);
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const https=require('node:https');const fs=require('node:fs');const c=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));https.get(new URL('/fixture/authority-ready',c.remote.origin),{ca:fs.readFileSync('/tmp/owner-ca.pem')},r=>r.pipe(process.stdout)).once('error',()=>process.exit(1));",
  ]);
  const registered = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const {request}=require('node:https');const fs=require('node:fs');const config=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));const call=request(new URL('/fixture/connected',config.remote.origin),{ca:fs.readFileSync('/tmp/owner-ca.pem')},response=>response.pipe(process.stdout));call.once('error',()=>process.exit(1));call.end();",
    ]),
  );
  assert.equal(registered.connected, true);
  await docker([
    "exec",
    container,
    node,
    "-e",
    "require('node:fs').writeFileSync('/workspaces/project/github-release','release')",
  ]);
  let githubStatus;
  do {
    githubStatus = JSON.parse(await cli("get", githubHeld.operation)).structuredContent;
  } while (githubStatus.state === "pending");
  assert.equal(githubStatus.outcome.ok, true);
  assert.equal(
    JSON.parse(await cli("output", githubHeld.process)).structuredContent.text,
    "same-github-owner",
  );
  assert.equal(JSON.parse(await cli("read", "github-continuity")).structuredContent.text, "once\n");
  if (process.argv.includes("--rename-only")) {
    const renamed = {
      ...configuration,
      repositoryFullName: "owner/renamed",
      previousRepositoryFullName: configuration.repositoryFullName,
    };
    for (const refused of [
      { ...renamed, repositoryId: "2" },
      {
        ...renamed,
        resourceId: randomUUID(),
        remote: { ...renamed.remote, resourceId: randomUUID() },
      },
      { ...renamed, previousRepositoryFullName: "foreign/project" },
    ]) {
      await assert.rejects(
        fixed(WORKSPACE_CONFIGURE_SCRIPT, JSON.stringify(refused)),
        /WORKSPACE_REPOSITORY_REBIND_UNPROVEN/,
      );
    }
    const proof = JSON.parse(
      await fixed(
        WORKSPACE_GITHUB_PROOF_SCRIPT,
        JSON.stringify({
          resourceId,
          repositoryId: "1",
          repositoryFullName: renamed.repositoryFullName,
          previousRepositoryFullName: configuration.repositoryFullName,
        }),
      ),
    );
    assert.equal(proof.root, configuration.root);
    await fixed(
      WORKSPACE_CONFIGURE_SCRIPT,
      JSON.stringify({ ...renamed, rootDevice: proof.rootDevice, rootInode: proof.rootInode }),
    );
    await fixed(WORKSPACE_START_SCRIPT);
    assert.equal(
      JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).repositoryFullName,
      renamed.repositoryFullName,
    );
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const fs=require('node:fs');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');const path='/home/agent/.local/share/moira-workspace/config.json';const config=JSON.parse(fs.readFileSync(path));assert.equal(config.github.repositoryId,'1');assert.equal(config.binding.repositoryFullName,'owner/renamed');assert.equal(execFileSync('/usr/bin/git',['-C','/workspaces/project','config','--get','remote.origin.url'],{encoding:'utf8'}).trim(),'https://github.com/owner/project.git');delete config.github.repositoryId;fs.writeFileSync(path,JSON.stringify(config),{mode:384});",
    ]);
    await assert.rejects(
      fixed(
        WORKSPACE_CONFIGURE_SCRIPT,
        JSON.stringify({
          ...renamed,
          repositoryFullName: "owner/second-rename",
          previousRepositoryFullName: renamed.repositoryFullName,
        }),
      ),
      /WORKSPACE_REPOSITORY_REBIND_UNPROVEN/,
    );
    console.log(
      "Verified same numeric/resource guest rename proof and reconfiguration without changing the canonical Git origin; wrong identity/prior-name and legacy unproved rename refuse. This is a disposable Linux owner fixture, not real GitHub provider proof.",
    );
    break verification;
  }
  const health = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT));
  assert.equal(health.processId, ready.processId);
  const exclusiveOwner = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const fs=require('node:fs');const {spawnSync}=require('node:child_process');const base='/home/agent/.local/state/moira/workspace-service';const owner=JSON.parse(fs.readFileSync(base+'/daemon.json'));const fd=fs.statSync('/proc/'+owner.pid+'/fd/4');const lock=fs.statSync(base+'/daemon.lock');const info=fs.readFileSync('/proc/'+owner.pid+'/fdinfo/4','utf8');const attempt=spawnSync('/usr/bin/flock',['--exclusive','--nonblock',base+'/daemon.lock','/bin/true']);process.stdout.write(JSON.stringify({pid:owner.pid,sameInode:fd.dev===lock.dev&&fd.ino===lock.ino,heldKernelLock:info.split('\\n').some(line=>/^lock:\\s+\\S+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+/.test(line)),competingStatus:attempt.status}));",
    ]),
  );
  assert.deepEqual(exclusiveOwner, {
    pid: ready.processId,
    sameInode: true,
    heldKernelLock: true,
    competingStatus: 1,
  });
  const diagnosticSnapshot = async () =>
    JSON.parse(
      await docker([
        "exec",
        container,
        node,
        "-e",
        `const fs=require('node:fs'),crypto=require('node:crypto');const base='/home/agent/.local/state/moira/workspace-service';const files=[];let ready=false,warning=false;for(let i=0;i<${DAEMON_DIAGNOSTIC_FILE_COUNT};i++){const name=i?'daemon.log.'+i:'daemon.log';let value;try{value=fs.lstatSync(base+'/'+name)}catch(error){if(error.code==='ENOENT')continue;throw error}const bytes=fs.readFileSync(base+'/'+name);ready||=bytes.includes(Buffer.from('"workspaceService":"ready"'));warning||=bytes.includes(Buffer.from('packaged-daemon-warning-tail'));files.push({name,size:value.size,mode:value.mode&511,nlink:value.nlink,regular:value.isFile(),sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}process.stdout.write(JSON.stringify({files,ready,warning}));`,
      ]),
    );
  const originalDiagnostics = await diagnosticSnapshot();
  assert.equal(originalDiagnostics.ready, true);
  await assert.rejects(
    docker(["exec", container, node, `${program}/service/daemon.mjs`, "--start"]),
  );
  await assert.rejects(
    docker(["exec", container, node, `${program}/service/daemon.mjs`, "--owned-daemon"]),
  );
  assert.deepEqual(await diagnosticSnapshot(), originalDiagnostics);
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).processId, ready.processId);
  assert.equal(
    JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).environmentIdentity,
    measured.environmentIdentity,
  );
  assert.match((await cli("--help")).toString(), /moira-workspace exec/);
  await assert.rejects(
    cli("exec", "--", "/bin/sh", "-c", "printf owned-runtime; printf error-stream >&2; exit 23"),
  );
  // The CLI failure loses its reply here. Discovery and pure original collection
  // recover the one admitted command rather than submitting the script again.
  const originals = (await semantic("operation_find", { kind: "command" })).structuredContent
    .operations;
  const collected = await Promise.all(
    originals.map(({ operation }) => semantic("operation_get", { reference: operation })),
  );
  const failures = collected
    .map((entry) => entry.structuredContent)
    .filter((entry) => entry.outcome?.result?.exitCode === 23);
  assert.equal(failures.length, 1);
  const failedProcess = failures[0].process;
  assert.equal(
    JSON.parse(await cli("output", failedProcess, "--stream", "stdout")).structuredContent.text,
    "owned-runtime",
  );
  assert.equal(
    JSON.parse(await cli("output", failedProcess, "--stream", "stderr")).structuredContent.text,
    "error-stream",
  );
  // The command receives valid per-string Linux argv/env values, while their
  // aggregate JSON crosses the collector pipe's UTF-8 chunk boundaries.
  const unicode = "€🙂Ж".repeat(6000);
  const unicodeBytes = Buffer.from(unicode);
  const unicodeInput = Buffer.from(unicode.repeat(2));
  const unicodeAccepted = await docker(
    [
      "exec",
      "--interactive",
      container,
      "/home/agent/.local/bin/moira-workspace",
      "exec",
      "--stdin",
      "--",
      "/usr/bin/env",
      `FIRST_UNICODE=${unicode}`,
      `SECOND_UNICODE=${unicode}`,
      `THIRD_UNICODE=${unicode}`,
      node,
      "-e",
      "const {createHash}=require('node:crypto');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks);process.stdout.write(JSON.stringify({environments:['FIRST_UNICODE','SECOND_UNICODE','THIRD_UNICODE'].map(key=>({size:Buffer.byteLength(process.env[key]),sha256:createHash('sha256').update(process.env[key]).digest('hex')})),stdin:{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}))})",
    ],
    unicodeInput,
  );
  const unicodeResult = JSON.parse(unicodeAccepted).structuredContent;
  assert.equal(unicodeResult.state, "completed");
  assert.equal(unicodeResult.outcome.ok, true);
  assert.deepEqual(JSON.parse(unicodeResult.stdout), {
    environments: Array(3).fill({
      size: unicodeBytes.length,
      sha256: createHash("sha256").update(unicodeBytes).digest("hex"),
    }),
    stdin: {
      size: unicodeInput.length,
      sha256: createHash("sha256").update(unicodeInput).digest("hex"),
    },
  });
  const bytes = Buffer.from([0, 255, 1, 13, 10]);
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/tmp/binary',require('node:fs').readFileSync(0))",
    ],
    bytes,
  );
  await cli("upload", "binary.dat", "/tmp/binary");
  await assert.rejects(cli("read", "binary.dat"));
  const publication = JSON.parse(await cli("download", "binary.dat"));
  const file = publication.structuredContent?.file;
  assert.ok(file && !publication.isError, "Packaged CLI publication failed");
  assert.equal(file.name, "binary.dat");
  assert.equal(file.mime_type, "application/octet-stream");
  assert.equal(file.size_bytes, bytes.length);
  assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(Number.isSafeInteger(file.expires_at) && file.expires_at > Date.now());
  const prefix = `owner-file://workspace/${configuration.remote.resourceId}/`;
  assert.ok(
    typeof file.reference_id === "string" && file.reference_id.startsWith(prefix),
    "Publication scope differs from the configured resource",
  );
  const token = file.reference_id.slice(prefix.length);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), "Publication capability is malformed");
  const link = publication.content?.[0];
  assert.ok(
    link?.type === "resource_link" &&
      link.uri ===
        `${configuration.remote.origin}/api/codespaces/files/${configuration.remote.resourceId}/${token}`,
    "Packaged CLI did not return the owner public link",
  );
  assert.equal(link.name, file.name);
  assert.equal(link.mimeType, file.mime_type);
  assert.equal(link.size, file.size_bytes);
  // The capability travels through private stdin, never argv or diagnostic output.
  const publicationBytes = (selectedToken = token) =>
    docker(
      [
        "exec",
        "--interactive",
        container,
        node,
        "-e",
        "const fs=require('node:fs');const {request}=require('node:http');const {token,socketPath}=JSON.parse(fs.readFileSync(0,'utf8'));const req=request({socketPath,method:'GET',path:'/v1/publications/'+encodeURIComponent(token)},res=>{if(res.statusCode!==200){res.resume();process.stderr.write('Owner publication refused');process.exitCode=1;return;}res.on('error',()=>{process.stderr.write('Owner publication stream failed');process.exitCode=1;});res.pipe(process.stdout);});req.on('error',()=>{process.stderr.write('Owner publication unavailable');process.exitCode=1;});req.end();",
      ],
      JSON.stringify({
        token: selectedToken,
        socketPath: `${activeHome}/.local/state/moira/workspace-service/service.sock`,
      }),
    );
  assert.deepEqual(await publicationBytes(), bytes);
  assert.deepEqual(await publicationBytes(), bytes);
  // Exercise the shipped daemon, CLI transport export, binary handler and native
  // supervisor together. Only the vendor authority is a confined TLS fixture.
  const deliveryRequestId = createWorkspaceRequestId();
  const deliveryInput = {
    action: "deliver",
    requestId: deliveryRequestId,
    source: { type: "publication", referenceId: file.reference_id },
    channelIds: ["channel-probe.notifications"],
    kind: "document",
    text: "packaged custom binary",
  };
  const delivery = await deliver("POST", "/v1/communication", deliveryInput);
  assert.equal(delivery.state, "completed");
  assert.equal(delivery.outcome?.ok, true);
  assert.equal(delivery.outcome.result.status, "delivered");
  assert.equal(delivery.stages.length, 1);
  assert.equal(delivery.stages[0].status, "delivered");
  assert.deepEqual(await deliver("POST", "/v1/communication", deliveryInput), delivery);
  assert.deepEqual(
    await deliver("GET", `/v1/communication/operations/${deliveryRequestId}`),
    delivery,
  );
  const extensionObserved = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const https=require('node:https');const fs=require('node:fs');const config=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));https.get(new URL('/fixture/extension',config.remote.origin),{ca:fs.readFileSync('/tmp/owner-ca.pem')},response=>response.pipe(process.stdout)).once('error',()=>process.exit(1));",
    ]),
  );
  assert.deepEqual(extensionObserved, {
    prepared: 1,
    artifacts: 1,
    sent: 1,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  // The actual daemon loads its shipped archive asset and private locked tar
  // dependency; a host renderer callback cannot satisfy this observation.
  const materializeRequestId = createWorkspaceRequestId();
  const materializeFiles = [
    { path: "guides/инструкция🙂.md", content: "Привет, 世界 🙂\n" },
    { path: "empty.txt", content: "" },
  ];
  const materializeInput = {
    action: "publish",
    requestId: materializeRequestId,
    expectedScope: {
      kind: "workspace",
      resourceId,
      resourceGeneration: 1,
      authorizationGeneration: 1,
      environmentIdentity: measured.environmentIdentity,
    },
    source: { type: "materialize-text-set", files: materializeFiles },
  };
  const archiveReceipt = await deliver("POST", "/v1/communication", materializeInput);
  assert.equal(archiveReceipt.outcome?.ok, true);
  const archive = archiveReceipt.outcome.result.file;
  assert.equal(archive.fileName, "materialize.tar");
  assert.equal(archive.mimeType, "application/x-tar");
  const archiveToken = archive.referenceId.split("/").at(-1);
  const archiveBytes = await publicationBytes(archiveToken);
  assert.equal(archiveBytes.length, archive.size);
  assert.equal(createHash("sha256").update(archiveBytes).digest("hex"), archive.sha256);
  const extractedFiles = await new Promise((resolve, reject) => {
    const parser = tar.extract();
    const files = [];
    parser.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.once("error", reject);
      stream.once("end", () => {
        files.push({ path: header.name, content: Buffer.concat(chunks).toString("utf8") });
        next();
      });
    });
    parser.once("error", reject);
    parser.once("finish", () => resolve(files));
    parser.end(archiveBytes);
  });
  assert.deepEqual(extractedFiles, materializeFiles);
  assert.deepEqual(await deliver("POST", "/v1/communication", materializeInput), archiveReceipt);
  assert.deepEqual(
    await deliver("GET", `/v1/communication/operations/${materializeRequestId}`),
    archiveReceipt,
  );
  assert.deepEqual(await publicationBytes(archiveToken), archiveBytes);
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/workspaces/project/binary.dat',require('node:fs').readFileSync(0))",
    ],
    Buffer.from("changed workspace version"),
  );
  assert.deepEqual(await publicationBytes(), bytes);
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/workspaces/project/binary.dat',require('node:fs').readFileSync(0))",
    ],
    bytes,
  );
  // Reuse the real small PNG fixture shape from owner image tests; no source-network claim.
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#aabbcc" } })
    .png()
    .toBuffer();
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/tmp/preview.png',require('node:fs').readFileSync(0))",
    ],
    png,
  );
  await cli("upload", "preview.png", "/tmp/preview.png");
  const preview = JSON.parse(await cli("preview", "preview.png"));
  assert.ok(!preview.isError, "Packaged CLI preview failed");
  assert.deepEqual(preview.structuredContent, {
    mime_type: "image/png",
    width: 3,
    height: 2,
    size_bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  });
  const image = preview.content?.find((block) => block.type === "image");
  assert.ok(image && image.mimeType === "image/png", "Packaged CLI omitted the owner image");
  assert.deepEqual(Buffer.from(image.data, "base64"), png);
  await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload));
  await fixed(WORKSPACE_START_SCRIPT);
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).releaseIdentity, payload.release);
  assert.equal(
    JSON.parse(await cli("output", failedProcess, "--stream", "stdout")).structuredContent.text,
    "owned-runtime",
  );
  assert.deepEqual(await publicationBytes(), bytes);
  await assert.rejects(cli("read", "../outside"));
  // The real detached collector, not owner collection, retires proved input
  // after completion while the daemon is absent. Output remains independent.
  const retainedInput = Buffer.alloc(128 * 1024, "i");
  const fullOutputBytes = DAEMON_DIAGNOSTIC_FILE_BYTES * 4;
  const retirementArgv = [
    node,
    "-e",
    `const fs=require('node:fs'),crypto=require('node:crypto');const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const input=Buffer.concat(chunks);fs.appendFileSync('retirement-once','once\\n');fs.writeFileSync('retirement-input-sha',crypto.createHash('sha256').update(input).digest('hex'));fs.writeFileSync('retirement-ready','ready');const timer=setInterval(()=>{if(fs.existsSync('retirement-release')){clearInterval(timer);process.stdout.write('O'.repeat(${fullOutputBytes}));process.stderr.write('E'.repeat(${fullOutputBytes}));}},10)});`,
  ];
  const retained = JSON.parse(
    await docker(
      [
        "exec",
        "--interactive",
        container,
        "/home/agent/.local/bin/moira-workspace",
        "exec",
        "--background",
        "--stdin",
        "--",
        ...retirementArgv,
      ],
      retainedInput,
    ),
  ).structuredContent;
  const retainedId = decodeReference(retained.operation, "operation").requestId;
  const requestsPath = `/home/agent/.local/state/moira/workspace-service/requests/${retainedId}`;
  const membershipPath = `/home/agent/.local/state/moira/workspace-service/active-requests/${retainedId}.json`;
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';import assert from 'node:assert/strict';await new Promise(done=>{const observe=()=>{if(fs.existsSync('/workspaces/project/retirement-ready')){watcher.close();done()}};const watcher=fs.watch('/workspaces/project',observe);observe()});assert.equal(fs.readFileSync('/workspaces/project/retirement-input-sha','utf8'),${JSON.stringify(createHash("sha256").update(retainedInput).digest("hex"))});assert.equal(fs.statSync(${JSON.stringify(`${requestsPath}/input`)}).size,${retainedInput.length});assert.ok(fs.existsSync(${JSON.stringify(membershipPath)}));assert.ok(fs.existsSync(${JSON.stringify(`${requestsPath}/accepted.json`)}));`,
  ]);
  const previousGhOwner = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT));
  await docker(["exec", container, node, `${program}/service/daemon.mjs`, "--stop"]);
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  const stoppedOwner = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      `const fs=require('node:fs');const {spawnSync}=require('node:child_process');let actorAbsent=false;try{const record=fs.readFileSync('/proc/${previousGhOwner.processId}/stat','utf8');actorAbsent=['Z','X'].includes(record.slice(record.lastIndexOf(') ')+2).split(' ')[0])}catch(error){if(error.code!=='ENOENT')throw error;actorAbsent=true}const attempt=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','/home/agent/.local/state/moira/workspace-service/daemon.lock','/bin/true']);process.stdout.write(JSON.stringify({actorAbsent,competingStatus:attempt.status}));`,
    ]),
  );
  assert.deepEqual(stoppedOwner, { actorAbsent: true, competingStatus: 0 });
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';import assert from 'node:assert/strict';const request=${JSON.stringify(requestsPath)},member=${JSON.stringify(membershipPath)};const snapshots=['accepted.json','input.json','input-identity.json'].map(name=>fs.readFileSync(request+'/'+name));fs.writeFileSync('/workspaces/project/retirement-release','release');await new Promise(done=>{const check=()=>{if(!fs.existsSync(request+'/input')&&!fs.existsSync(member)){for(const watcher of watchers)watcher.close();done()}};const watchers=[fs.watch(request,check),fs.watch('/home/agent/.local/state/moira/workspace-service/active-requests',check)];check()});for(const [index,name]of ['accepted.json','input.json','input-identity.json'].entries())assert.deepEqual(fs.readFileSync(request+'/'+name),snapshots[index]);const engine='/home/agent/.local/state/moira/workspace-service/engine/moira-op-'+${JSON.stringify(retainedId.slice(4).replaceAll("-", ""))};const result=JSON.parse(fs.readFileSync(engine+'/result.json'));assert.equal(result.state,'succeeded');assert.equal(result.inputSettled,true);assert.equal(fs.statSync(engine+'/stdout.log').size,${fullOutputBytes});assert.equal(fs.statSync(engine+'/stderr.log').size,${fullOutputBytes});assert.equal(fs.readFileSync('/workspaces/project/retirement-once','utf8'),'once\\n');`,
  ]);
  // Oversized legacy diagnostics and actual Node warnings pass through the
  // newly started daemon's writer, never a host-side pathname rotation.
  await docker([
    "exec",
    container,
    node,
    "-e",
    `const fs=require('node:fs');const base='/home/agent/.local/state/moira/workspace-service';for(let i=0;i<${DAEMON_DIAGNOSTIC_FILE_COUNT};i++)fs.writeFileSync(base+'/'+(i?'daemon.log.'+i:'daemon.log'),Buffer.alloc(${DAEMON_DIAGNOSTIC_FILE_BYTES * 2},'d'),{mode:384});fs.writeFileSync('/tmp/daemon-warning-fixture.cjs',${JSON.stringify(`if(process.argv.includes('--owned-daemon')&&process.send){const send=process.send.bind(process);process.send=(message,...args)=>{const value=send(message,...args);if(message?.type==='workspace-service-ready')process.emitWarning('d'.repeat(${DAEMON_DIAGNOSTIC_FILE_BYTES * 4})+'packaged-daemon-warning-tail',{code:'PACKAGED_DAEMON_WARNING'});return value}}`)},{mode:384});`,
  ]);
  const restarted = JSON.parse(
    await docker([
      "exec",
      "--env",
      "NODE_OPTIONS=--require=/tmp/daemon-warning-fixture.cjs",
      container,
      node,
      `${program}/service/daemon.mjs`,
      "--start",
    ]),
  );
  assert.notEqual(restarted.processId, previousGhOwner.processId);
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';const base='/home/agent/.local/state/moira/workspace-service';await new Promise(done=>{const check=()=>{for(let i=0;i<${DAEMON_DIAGNOSTIC_FILE_COUNT};i++){try{if(fs.readFileSync(base+'/'+(i?'daemon.log.'+i:'daemon.log')).includes(Buffer.from('packaged-daemon-warning-tail'))){watcher.close();done();return}}catch(error){if(error.code!=='ENOENT')throw error}}};const watcher=fs.watch(base,check);check()});`,
  ]);
  const boundedDiagnostics = await diagnosticSnapshot();
  assert.equal(boundedDiagnostics.warning, true);
  assert.equal(boundedDiagnostics.files.length, DAEMON_DIAGNOSTIC_FILE_COUNT);
  for (const entry of boundedDiagnostics.files) {
    assert.ok(entry.size <= DAEMON_DIAGNOSTIC_FILE_BYTES);
    assert.equal(entry.mode, 0o600);
    assert.equal(entry.nlink, 1);
    assert.equal(entry.regular, true);
  }
  const retiredOriginal = JSON.parse(await cli("get", retained.operation)).structuredContent;
  assert.equal(retiredOriginal.state, "completed");
  assert.equal(retiredOriginal.outcome.ok, true);
  for (const [stream, character] of [
    ["stdout", "O"],
    ["stderr", "E"],
  ]) {
    const output = JSON.parse(
      await cli(
        "output",
        retained.process,
        "--stream",
        stream,
        "--max-bytes",
        String(fullOutputBytes),
      ),
    ).structuredContent;
    assert.equal(output.total_bytes, fullOutputBytes);
    assert.equal(output.text, character.repeat(fullOutputBytes));
  }
  const originalIntent = { command: { argv: retirementArgv }, background: true };
  const replay = await semanticStream("command_run", originalIntent, retainedId, retainedInput);
  assert.equal(replay.structuredContent.operation, retained.operation);
  assert.equal(replay.structuredContent.state, "completed");
  assert.equal(replay.structuredContent.outcome.ok, true);
  const altered = await semanticStream(
    "command_run",
    originalIntent,
    retainedId,
    Buffer.from("changed original stdin"),
  );
  assert.equal(altered.isError, true);
  assert.equal(altered.structuredContent.error.code, "REQUEST_ID_CONFLICT");
  assert.equal(JSON.parse(await cli("read", "retirement-once")).structuredContent.text, "once\n");
  await docker(["exec", container, node, `${program}/service/daemon.mjs`, "--stop"]);
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  // A distinct disposable Local home/repository keeps the GitHub selector,
  // configuration and original journals intact; provider identity is never relabelled.
  activeHome = "/home/agent/local-owner";
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const fs=require('node:fs');const {execFileSync}=require('node:child_process');fs.mkdirSync('/home/agent/local-owner',{mode:448});fs.mkdirSync('/workspaces/local-project',{mode:448});execFileSync('/usr/bin/git',['init','/workspaces/local-project']);execFileSync('/usr/bin/git',['-C','/workspaces/local-project','remote','add','origin','https://github.com/owner/local-project.git']);fs.copyFileSync('/tmp/binary','/workspaces/local-project/binary.dat');",
  ]);
  await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload));
  const localOnly = {
    version: 1,
    mode: "local-only",
    ownerSelector: {
      kind: "local",
      deviceId: randomUUID(),
      spaceId: randomUUID(),
      operationMarker: "moira-" + "a".repeat(24),
    },
    repositoryFullName: "owner/local-project",
    root: "/workspaces/local-project",
    expectedOrigin: "https://github.com/owner/local-project.git",
    environmentIdentity: measured.environmentIdentity,
  };
  // Explicit owner-only mode still requires the installed Local proxy and the
  // measured guest life. Missing binding must fail rather than disabling checks.
  await assert.rejects(fixed(WORKSPACE_CONFIGURE_SCRIPT, JSON.stringify(localOnly)));
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const fs=require('node:fs');const path='/home/agent/local-owner/.local/share/moira-local';fs.mkdirSync(path,{recursive:true,mode:448});fs.writeFileSync(path+'/environment.json',JSON.stringify({HTTPS_PROXY:'http://fixture:owner-proxy@127.0.0.1:3437'}),{mode:384})",
  ]);
  await assert.rejects(
    fixed(
      WORKSPACE_CONFIGURE_SCRIPT,
      JSON.stringify({ ...localOnly, environmentIdentity: "f".repeat(64) }),
    ),
  );
  await fixed(WORKSPACE_CONFIGURE_SCRIPT, JSON.stringify(localOnly));
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const assert=require('node:assert/strict');const config=JSON.parse(require('node:fs').readFileSync('/home/agent/local-owner/.local/share/moira-workspace/config.json'));assert.equal(Object.hasOwn(config,'remote'),false);assert.equal(new URL(config.proxy).port,'3437');assert.match(config.environmentIdentity,/^[a-f0-9]{64}$/)",
  ]);
  const localReady = JSON.parse(await fixed(WORKSPACE_START_SCRIPT));
  assert.equal(localReady.environmentIdentity, measured.environmentIdentity);
  assert.equal(localReady.releaseIdentity, payload.release);
  await assert.rejects(cli("output", failedProcess, "--stream", "stdout"));
  const localResult = JSON.parse(
    await cli(
      "exec",
      "--",
      node,
      "-e",
      "const target=new URL(process.env.HTTPS_PROXY);if(target.hostname!=='127.0.0.1'||target.port!=='3437')process.exit(37);process.stdout.write('local-owner-ready')",
    ),
  ).structuredContent;
  assert.equal(localResult.state, "completed");
  assert.equal(localResult.outcome.ok, true);
  assert.equal(localResult.stdout, "local-owner-ready");
  const held = JSON.parse(
    await cli(
      "exec",
      "--background",
      "--",
      node,
      "-e",
      "const fs=require('node:fs');fs.appendFileSync('setup-continuity','once\\n');fs.writeFileSync('setup-job-ready','ready');const timer=setInterval(()=>{if(fs.existsSync('setup-job-release')){clearInterval(timer);process.stdout.write('continued-after-enrollment')}},10)",
    ),
  ).structuredContent;
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    "import {watch,existsSync} from 'node:fs';await new Promise(done=>{const observe=()=>{if(existsSync('/workspaces/local-project/setup-job-ready')){watcher.close();done()}};const watcher=watch('/workspaces/local-project',observe);observe()});",
  ]);
  // A real fixed Local CONNECT gateway inside this disposable container lets
  // the shipped daemon enroll after starting local-only. No host port is opened.
  const gateway = await build({
    stdin: {
      contents: `
        import {createServer} from 'node:http';import {connect} from 'node:net';
        const target=new URL(${JSON.stringify(router.origin)}),server=createServer();
        server.on('connect',(request,socket,head)=>{
          if(request.url!==target.host||head.length||request.headers['proxy-authorization']!=='Basic '+Buffer.from('fixture:owner-proxy').toString('base64')){socket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');return;}
          const upstream=connect(Number(target.port),target.hostname);upstream.once('error',()=>socket.destroy());socket.once('error',()=>upstream.destroy());
          socket.once('close',()=>upstream.destroy());upstream.once('close',()=>socket.destroy());
          upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');socket.pipe(upstream);upstream.pipe(socket);});
        });
        await new Promise((done,reject)=>{server.once('error',reject);server.listen(3437,'127.0.0.1',done)});process.send({ready:true});
      `,
      resolveDir: process.cwd(),
      sourcefile: "guest-local-gateway.mjs",
      loader: "js",
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
  });
  await docker(
    [
      "exec",
      "--interactive",
      container,
      node,
      "-e",
      "require('node:fs').writeFileSync('/tmp/local-gateway.mjs',require('node:fs').readFileSync(0),{mode:384})",
    ],
    gateway.outputFiles[0].contents,
  );
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['/tmp/local-gateway.mjs'],{detached:true,stdio:['ignore','ignore','inherit','ipc']});child.once('error',()=>process.exit(1));child.once('exit',()=>process.exit(1));child.once('message',value=>{if(!value.ready)process.exit(1);child.disconnect();child.unref();});",
  ]);
  await fixed(
    WORKSPACE_CONFIGURE_SCRIPT,
    JSON.stringify({ ...localOnly, remote: configuration.remote }),
  );
  const enrolled = JSON.parse(await fixed(WORKSPACE_START_SCRIPT));
  assert.equal(enrolled.processId, localReady.processId);
  assert.equal(enrolled.environmentIdentity, localReady.environmentIdentity);
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const https=require('node:https');const fs=require('node:fs');const c=JSON.parse(fs.readFileSync('/home/agent/local-owner/.local/share/moira-workspace/config.json'));https.get(new URL('/fixture/connected',c.remote.origin),{ca:fs.readFileSync('/tmp/owner-ca.pem')},r=>r.pipe(process.stdout)).once('error',()=>process.exit(1));",
  ]);
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).remote.state, "connected");
  const enrolledPublication = JSON.parse(await cli("download", "binary.dat"));
  assert.ok(!enrolledPublication.isError, "Live enrollment did not enable owner publication");
  assert.equal(
    enrolledPublication.structuredContent.file.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  await docker([
    "exec",
    container,
    node,
    "-e",
    "require('node:fs').writeFileSync('/workspaces/local-project/setup-job-release','release')",
  ]);
  let status;
  do {
    status = JSON.parse(await cli("get", held.operation)).structuredContent;
  } while (status.state === "pending");
  assert.equal(status.state, "completed");
  assert.equal(status.outcome.ok, true);
  assert.equal(
    JSON.parse(await cli("output", held.process, "--stream", "stdout")).structuredContent.text,
    "continued-after-enrollment",
  );
  assert.equal(JSON.parse(await cli("read", "setup-continuity")).structuredContent.text, "once\n");
  assert.deepEqual(
    await publicationBytes(
      enrolledPublication.structuredContent.file.reference_id.split("/").at(-1),
    ),
    bytes,
  );
  await docker([
    "exec",
    "--env",
    `HOME=${activeHome}`,
    container,
    node,
    `${program}/service/daemon.mjs`,
    "--stop",
  ]);
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  // Persistent disposable volumes keep physical root identity while the container's
  // real PID1 start changes. This is a cold guest life, not an observer restart.
  activeHome = "/home/agent/unenrolled-owner";
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const fs=require('node:fs'),{execFileSync}=require('node:child_process');fs.mkdirSync('/home/agent/unenrolled-owner',{mode:448});fs.mkdirSync('/workspaces/unenrolled',{mode:448});execFileSync('/usr/bin/git',['init','/workspaces/unenrolled']);execFileSync('/usr/bin/git',['-C','/workspaces/unenrolled','remote','add','origin','https://github.com/owner/unenrolled.git']);fs.writeFileSync('/workspaces/unenrolled/sentinel','preserved')",
  ]);
  await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload));
  const unenrolledId = randomUUID();
  const unenrolledProof = JSON.parse(
    await fixed(
      WORKSPACE_GITHUB_PROOF_SCRIPT,
      JSON.stringify({
        resourceId: unenrolledId,
        repositoryId: "2",
        repositoryFullName: "owner/unenrolled",
      }),
    ),
  );
  await fixed(
    WORKSPACE_CONFIGURE_SCRIPT,
    JSON.stringify({
      version: 1,
      mode: "local-only",
      resourceId: unenrolledId,
      repositoryId: "2",
      repositoryFullName: "owner/unenrolled",
      ownerSelector: { kind: "github", resourceId: unenrolledId },
      ...unenrolledProof,
      expectedRelease: payload.release,
    }),
  );
  activeHome = "/home/agent";
  const coldBefore = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));const s=fs.statSync(c.binding.root);process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino,life:c.environmentIdentity}))",
    ]),
  );
  await docker(["restart", container]);
  // Node reads NODE_EXTRA_CA_CERTS at process startup. Restore only passive
  // fixture assets before the daemon starts; the authority server stays down.
  routerAssets[4][1] = Buffer.from(
    JSON.stringify({
      ...routerInput,
      port: Number(new URL(router.origin).port),
      origin: router.origin,
    }),
  );
  await installRouterAssets();
  const coldLife = JSON.parse(await fixed(WORKSPACE_PROBE_SCRIPT));
  assert.notEqual(coldLife.environmentIdentity, coldBefore.life);
  activeHome = "/home/agent/unenrolled-owner";
  await assert.rejects(fixed(WORKSPACE_START_SCRIPT));
  await assert.rejects(fixed(WORKSPACE_HEALTH_SCRIPT));
  await docker([
    "exec",
    container,
    node,
    "-e",
    `const fs=require('node:fs'),assert=require('node:assert/strict');const c=JSON.parse(fs.readFileSync('/home/agent/unenrolled-owner/.local/share/moira-workspace/config.json'));assert.equal(c.environmentIdentity,${JSON.stringify(unenrolledProof.environmentIdentity)});assert.equal(fs.readFileSync('/workspaces/unenrolled/sentinel','utf8'),'preserved');assert.equal(fs.existsSync('/home/agent/unenrolled-owner/.local/state/moira/workspace-service/renewal-'+${JSON.stringify(coldLife.environmentIdentity)}+'.json'),false)`,
  ]);
  activeHome = "/home/agent";
  const coldReady = JSON.parse(await fixed(WORKSPACE_START_SCRIPT));
  assert.equal(coldReady.environmentIdentity, coldLife.environmentIdentity);
  assert.notEqual(coldReady.remote.state, "connected");
  assert.equal(JSON.parse(await cli("read", "github-continuity")).structuredContent.text, "once\n");
  const coldRoot = JSON.parse(
    await docker([
      "exec",
      container,
      node,
      "-e",
      "const s=require('node:fs').statSync('/workspaces/project');process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino}))",
    ]),
  );
  assert.deepEqual(coldRoot, { dev: coldBefore.dev, ino: coldBefore.ino });
  await startRouter();
  await docker([
    "exec",
    container,
    node,
    "--input-type=module",
    "-e",
    "import {watch,existsSync} from 'node:fs';await new Promise(done=>{const watcher=watch('/home/agent',()=>{if(existsSync('/home/agent/renewal-observed.json')){watcher.close();done()}});if(existsSync('/home/agent/renewal-observed.json')){watcher.close();done()}})",
  ]);
  assert.equal(JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)).processId, coldReady.processId);
  assert.equal(
    JSON.parse(await cli("exec", "--", "/bin/echo", "usable-during-renewal")).structuredContent
      .stdout,
    "usable-during-renewal\n",
  );
  await docker([
    "exec",
    container,
    node,
    "-e",
    "require('node:fs').writeFileSync('/home/agent/renewal-ready','ready')",
  ]);
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const https=require('node:https');const fs=require('node:fs');const c=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));https.get(new URL('/fixture/connected',c.remote.origin),{ca:fs.readFileSync('/tmp/owner-ca.pem')},r=>r.pipe(process.stdout)).once('error',()=>process.exit(1))",
  ]);
  const renewedHealth = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT));
  assert.equal(renewedHealth.processId, coldReady.processId);
  assert.equal(renewedHealth.environmentIdentity, coldLife.environmentIdentity);
  assert.equal(renewedHealth.remote.state, "connected");
  await docker([
    "exec",
    container,
    node,
    "-e",
    "const fs=require('node:fs'),assert=require('node:assert/strict');const c=JSON.parse(fs.readFileSync('/home/agent/.local/share/moira-workspace/config.json'));const observed=JSON.parse(fs.readFileSync('/home/agent/renewal-observed.json'));const original=JSON.parse(fs.readFileSync('/home/agent/.local/state/moira/workspace-service/renewal-'+c.environmentIdentity+'.json'));assert.deepEqual(observed,original);assert.equal(c.remote.credential,'z'.repeat(43));assert.equal(c.renewalPending,undefined)",
  ]);
  console.log(
    "Verified pinned Linux payload, exclusive directory publication preserving occupied targets and refusing replaced stages, credential-free GitHub Unix readiness and later enrollment with unchanged owner PID/life and one continuing command, a genuinely changed guest life with unchanged persistent root/inode/sentinels and local-ready renewal through the same durable request, refusal to regenerate a never-enrolled original proof across life changes, single-owner locking with unchanged diagnostics on competing/unlocked entry, bounded daemon restart diagnostics and actual Node warnings, detached stdin retirement without owner collection while original identity and full stdout/stderr survive restart and same-original replay, Local-only configuration and later live enrollment/publication, exact exit/output and binary files, immutable publications, packaged UTF-8 materialize tar, custom binary extension delivery and original-receipt collection, and PNG preview. Real GitHub provisioning, vendor delivery and native source networking were not exercised.",
  );
} catch (error) {
  // Imported application logging can handle uncaught exceptions; a failed
  // verifier must still return failure to its caller.
  process.exitCode = 1;
  throw error;
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) await docker(["rm", "--force", container]);
  for (const volume of ownedVolumes) await docker(["volume", "rm", volume]);
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
}
