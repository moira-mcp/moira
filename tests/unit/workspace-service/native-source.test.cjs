const { beforeAll, afterAll, expect, test } = require("@jest/globals");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, realpathSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:tls");
const { createServer: createHttpsServer } = require("node:https");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");

const transport = pathToFileURL(resolve("packages/workspace-service/src/tls-transport.mjs")).href;
const source = pathToFileURL(resolve("packages/workspace-service/src/native-source.mjs")).href;
let directory;
let key;
let ca;
beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "workspace-native-source-")));
  key = join(directory, "key.pem");
  ca = join(directory, "ca.pem");
  const result = spawnSync(
    "openssl",
    [
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      ca,
    ],
    { stdio: "ignore" },
  );
  if (result.status !== 0) throw new Error("Fixture certificate failed");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function child(script, environment = {}) {
  const process = spawn(global.process.execPath, ["--input-type=module"], {
    env: { ...global.process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  process.stdout.on("data", (bytes) => output.push(bytes));
  process.stderr.on("data", (bytes) => errors.push(bytes));
  const ended = once(process, "exit");
  process.stdin.end(script);
  const [code] = await ended;
  if (code !== 0) throw new Error(Buffer.concat(errors).toString());
  return JSON.parse(Buffer.concat(output).toString());
}

test("the extracted connector uses real verified TLS and refuses an untrusted certificate", async () => {
  const server = createServer({ key: readFileSync(key), cert: readFileSync(ca) }, (socket) => {
    socket.end("verified");
  });
  server.on("tlsClientError", () => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = server.address().port;
    const script = `import {connectHttps} from ${JSON.stringify(transport)};
      try {const socket=await connectHttps({hostname:'127.0.0.1',port:${port}});
      let body=''; for await(const bytes of socket) body+=bytes.toString();
      console.log(JSON.stringify({body}));}catch(error){console.log(JSON.stringify({error:error.message}));}`;
    expect(await child(script, { NODE_EXTRA_CA_CERTS: ca })).toEqual({ body: "verified" });
    expect(
      await child(script, { NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    ).toEqual({ error: "TLS transport refused" });
  } finally {
    await new Promise((done) => server.close(done));
  }
});

const controlledSource = `
  import https from 'node:https'; import tls from 'node:tls'; import dns from 'node:dns/promises';
  import timers from 'node:timers'; import {EventEmitter} from 'node:events';
  import {Readable} from 'node:stream'; import {syncBuiltinESMExports} from 'node:module';
  let lookups=0, connections=0, headerTimerActive=false;
  dns.lookup=async()=>{lookups++;return [{address:'8.8.8.8',family:4}]};
  tls.connect=(options)=>{connections++;const socket=new EventEmitter();socket.remoteAddress=options.host;
    socket.destroy=()=>socket.emit('close');queueMicrotask(()=>socket.emit('secureConnect'));return socket};
  timers.setTimeout=()=>{headerTimerActive=true;return {unref(){}}};
  timers.clearTimeout=()=>{headerTimerActive=false};
  let responseFactory;
  https.request=(options,callback)=>{const request=new EventEmitter();
    request.end=()=>queueMicrotask(()=>callback(responseFactory(options)));request.destroy=()=>{};return request};
  syncBuiltinESMExports();
  const {openNativeFile}=await import(${JSON.stringify(source)});
  const reference={fileId:'native-file',downloadUrl:'https://files.oaiusercontent.com/object?sig=private-sentinel'};
`;

test("transport custody ignores a TLS error until its physically held connection closes", async () => {
  const sockets = new Set();
  const server = createServer({ key: readFileSync(key), cert: readFileSync(ca) }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const result = await child(
      `
      import {connectHttps,transportClosed} from ${JSON.stringify(transport)};
      const socket=await connectHttps({hostname:'127.0.0.1',port:${server.address().port}});
      const destroy=socket.destroy.bind(socket);let destroyRequested=false,settled=false;
      socket.destroy=()=>{destroyRequested=true;return socket};
      const closed=transportClosed(socket).then(()=>{settled=true});
      socket.emit('error',new Error('controlled transport error before close'));
      await Promise.resolve();await Promise.resolve();
      const before={destroyRequested,settled,closed:socket.closed};
      socket.destroy=destroy;socket.destroy();await closed;
      console.log(JSON.stringify({before,after:{settled,closed:socket.closed}}));
    `,
      { NODE_EXTRA_CA_CERTS: ca },
    );
    expect(result).toEqual({
      before: { destroyRequested: true, settled: false, closed: false },
      after: { settled: true, closed: true },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  }
});

test.each([
  ["absent", null],
  ["live", null],
  ["live", "SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED"],
  ["live", "SCOPED_CREDENTIAL_DISPOSAL_PENDING"],
])(
  "uncertain security issuance keeps its durable nonce and restart %s/%s collection cannot mint another child",
  async (collectionState, issuerError) => {
    const stateRoot = join(directory, `security-${collectionState}-${issuerError ?? "lost-reply"}`);
    const resourceId = randomUUID();
    const credentialId = randomUUID();
    const requests = [];
    let writtenBeforeSubmission = false;
    const server = createHttpsServer(
      { key: readFileSync(key), cert: readFileSync(ca) },
      (request, response) => {
        void (async () => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests.push({ path: request.url, body });
          if (request.url.endsWith("/acquire")) {
            const receipt = JSON.parse(
              readFileSync(join(stateRoot, "requests", body.requestId, "result.json"), "utf8"),
            );
            writtenBeforeSubmission =
              receipt.state === "prepared" && receipt.requestId === body.requestId;
            if (issuerError) {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { code: issuerError } }));
            } else request.socket.destroy();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          if (request.url.includes("/requests/"))
            response.end(
              JSON.stringify(
                collectionState === "live"
                  ? {
                      state: "live",
                      credential: {
                        credentialId,
                        token: "private_child_token",
                        repositoryFullName: "owner/project",
                        expiresAt: Date.now() + 3600000,
                        useUntil: Date.now() + 600000,
                      },
                    }
                  : { state: "absent" },
              ),
            );
          else if (request.url.endsWith("/release"))
            response.end(JSON.stringify({ released: true }));
          else throw new Error("Unexpected issuer route");
        })().catch((error) => response.destroy(error));
      },
    );
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const broker = pathToFileURL(
        resolve("packages/workspace-service/src/github-broker.mjs"),
      ).href;
      const storeModule = pathToFileURL(
        resolve("packages/workspace-service/src/credential-workspace-store.mjs"),
      ).href;
      const result = await child(
        `
      import {workspaceGitAuthority} from ${JSON.stringify(broker)};import {credentialWorkspaceStore} from ${JSON.stringify(storeModule)};
      const remote={origin:'https://127.0.0.1:${server.address().port}',credential:'fixture-parent',resourceId:${JSON.stringify(resourceId)},resourceGeneration:1};
      const store=credentialWorkspaceStore(${JSON.stringify(stateRoot)});let errorCode,errorMessage,errorStatus,requestId;
      try{await workspaceGitAuthority(remote,'owner/project',store).acquire('fetch')}catch(error){errorCode=error.publicCode;errorMessage=error.message;errorStatus=error.status;requestId=error.securityRequestId}
      const before=await store.read(requestId);
      const after=await workspaceGitAuthority(remote,'owner/project',credentialWorkspaceStore(${JSON.stringify(stateRoot)})).collect(requestId);
      console.log(JSON.stringify({errorCode,errorMessage,errorStatus,requestId,before,after}));
    `,
        { NODE_EXTRA_CA_CERTS: ca },
      );
      expect(writtenBeforeSubmission).toBe(true);
      expect(result.errorCode).toBe(issuerError ?? "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED");
      expect(result.errorStatus).toBe(503);
      expect(result.requestId).toMatch(/^ws1-/);
      expect(result.before).toMatchObject({
        requestId: result.requestId,
        state: "unconfirmed",
        resourceId,
        action: "fetch",
      });
      if (issuerError) expect(result.errorMessage).toMatch(/unconfirmed/i);
      expect(result.after).toMatchObject({
        requestId: result.requestId,
        state: collectionState === "live" ? "live" : "absent",
      });
      expect(requests.map((entry) => entry.path)).toEqual([
        "/api/codespaces/github/credentials/acquire",
        `/api/codespaces/github/credentials/requests/${result.requestId}`,
      ]);
      expect(requests[1].body.requestId).toBe(result.requestId);
      expect(
        readFileSync(join(stateRoot, "requests", result.requestId, "result.json"), "utf8"),
      ).not.toContain("private_child_token");
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  },
);

test("accepted source bodies exceed former byte quotas with the header timer released", async () => {
  const result = await child(
    controlledSource +
      `
    const size=21*1024*1024+7; reference.declaredSize=size;
    responseFactory=()=>{const response=Readable.from((async function*(){
      for(let sent=0;sent<size;){const count=Math.min(65536,size-sent);sent+=count;yield Buffer.alloc(count,255)}
    })());response.statusCode=200;response.headers={'content-length':String(size),'content-type':'application/octet-stream'};return response};
    const opened=await openNativeFile(reference);const headerTimerWasActive=headerTimerActive;
    let received=0;for await(const bytes of opened.body)received+=bytes.length;
    console.log(JSON.stringify({received,headerTimerWasActive,lookups,connections}));
  `,
  );
  expect(result).toEqual({
    received: 21 * 1024 * 1024 + 7,
    headerTimerWasActive: false,
    lookups: 1,
    connections: 1,
  });
});

test("a redirect into an untrusted origin refuses before opening it and hides signed authority", async () => {
  const result = await child(
    controlledSource +
      `
    responseFactory=()=>{const response=Readable.from([]);response.statusCode=302;
      response.headers={location:'https://127.0.0.1/secret?sig=private-sentinel'};return response};
    try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({
      publicCode:error.publicCode,message:error.message,lookups,connections}))}
  `,
  );
  expect(result).toEqual({
    publicCode: "SOURCE_REFUSED",
    message: "Native file source refused",
    lookups: 1,
    connections: 1,
  });
});

test("mixed DNS answers refuse direct source acquisition before any TLS connection", async () => {
  const result = await child(
    controlledSource +
      `
    dns.lookup=async()=>[{address:'8.8.8.8',family:4},{address:'169.254.169.254',family:4}];
    syncBuiltinESMExports();
    try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({publicCode:error.publicCode,connections}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED", connections: 0 });
});

test("a malformed installed proxy cannot fall back to direct source TLS", async () => {
  const result = await child(
    controlledSource +
      `
    try{await openNativeFile(reference,{proxy:'http://owner:secret@127.0.0.1:3438/'})}
    catch(error){console.log(JSON.stringify({publicCode:error.publicCode,connections,lookups}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED", connections: 0, lookups: 0 });
});

test("a short declared source body is a confirmed source refusal and releases its stream", async () => {
  const result = await child(
    controlledSource +
      `
    reference.declaredSize=4;let response;
    responseFactory=()=>{response=Readable.from([Buffer.from([1,2,3])]);
      response.statusCode=200;response.headers={};return response};
    const opened=await openNativeFile(reference);
    try{for await(const bytes of opened.body){void bytes}}catch(error){console.log(JSON.stringify({
      publicCode:error.publicCode,destroyed:response.destroyed}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED", destroyed: true });
});

test("a refused Local CONNECT never falls back to guest DNS or direct TLS", async () => {
  const result = await child(
    controlledSource +
      `
    const http=await import('node:http');
    http.default.request=()=>{const request=new EventEmitter();request.destroy=()=>{};
      request.end=()=>queueMicrotask(()=>{const tunnel=new EventEmitter();tunnel.destroy=()=>{};
        request.emit('connect',{statusCode:403},tunnel,Buffer.alloc(0))});return request};
    syncBuiltinESMExports();
    try{await openNativeFile(reference,{proxy:'http://owner:secret@127.0.0.1:3437/'})}
    catch(error){console.log(JSON.stringify({publicCode:error.publicCode,connections,lookups}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED", connections: 0, lookups: 0 });
});

test("the actual connected direct peer must match the pinned public DNS answer", async () => {
  const result = await child(
    controlledSource +
      `
    tls.connect=()=>{const socket=new EventEmitter();socket.remoteAddress='1.1.1.1';
      socket.destroy=()=>socket.emit('close');queueMicrotask(()=>socket.emit('secureConnect'));return socket};
    syncBuiltinESMExports();
    try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({publicCode:error.publicCode}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED" });
});

test.each([
  "https://oaiusercontent.com/object?sig=private-sentinel",
  "https://attacker.blob.core.windows.net/object?sig=private-sentinel",
  "https://oaisdmntpr.example.com/object?sig=private-sentinel",
])("an untrusted native issuer %s refuses before DNS or TLS", async (downloadUrl) => {
  const result = await child(
    controlledSource +
      `
    reference.downloadUrl=${JSON.stringify(downloadUrl)};
    try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({
      publicCode:error.publicCode,message:error.message,lookups,connections}))}
  `,
  );
  expect(result).toEqual({
    publicCode: "SOURCE_REFUSED",
    message: "Native file source refused",
    lookups: 0,
    connections: 0,
  });
});

test("the supported Azure native issuer streams bytes with normalized MIME metadata", async () => {
  const result = await child(
    controlledSource +
      `
    reference.downloadUrl='https://oaisdmntprdenmarkeast.blob.core.windows.net/object?sig=private-sentinel';
    responseFactory=()=>{const response=Readable.from([Buffer.from([0,255,128])]);
      response.statusCode=200;response.headers={'content-type':'image/png; charset=binary','content-length':'3'};return response};
    const opened=await openNativeFile(reference);const bytes=[];for await(const chunk of opened.body)bytes.push(...chunk);
    console.log(JSON.stringify({bytes,mimeType:opened.mimeType,contentLength:opened.contentLength}));
  `,
  );
  expect(result).toEqual({ bytes: [0, 255, 128], mimeType: "image/png", contentLength: 3 });
});

test.each(["not-a-mime", "image/" + "x".repeat(257)])(
  "malformed MIME metadata refuses native header admission",
  async (mimeType) => {
    const result = await child(
      controlledSource +
        `
      responseFactory=()=>{const response=Readable.from([]);response.statusCode=200;
        response.headers={'content-type':${JSON.stringify(mimeType)}};return response};
      try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({publicCode:error.publicCode}))}
    `,
    );
    expect(result).toEqual({ publicCode: "SOURCE_REFUSED" });
  },
);

test("a source header contradicting declared size refuses before its body is admitted", async () => {
  const result = await child(
    controlledSource +
      `
    reference.declaredSize=4;
    responseFactory=()=>{const response=Readable.from([Buffer.from([1,2,3])]);response.statusCode=200;
      response.headers={'content-length':'3'};return response};
    try{await openNativeFile(reference)}catch(error){console.log(JSON.stringify({publicCode:error.publicCode}))}
  `,
  );
  expect(result).toEqual({ publicCode: "SOURCE_REFUSED" });
});

test("common native identity excludes signed URL rotation and rejects malformed descriptors before opening", async () => {
  const result = await child(`
    import {nativeFileIdentity,nativeFileBytes} from ${JSON.stringify(source)};
    const file={fileId:'native-id',downloadUrl:'https://files.oaiusercontent.com/one?sig=first',fileName:'image.png',mimeType:'image/png',declaredSize:3};
    const first=nativeFileIdentity(file);
    const rotated=nativeFileIdentity({...file,downloadUrl:'https://files.oaiusercontent.com/two?sig=rotated'});
    let opened=false,code,status;
    try{await nativeFileBytes({...file,untrusted:true},{sourceOpener:async()=>{opened=true}})}
    catch(error){code=error.publicCode;status=error.status}
    console.log(JSON.stringify({first,rotated,opened,code,status}));
  `);
  expect(result).toEqual({
    first: { fileId: "native-id", fileName: "image.png", mimeType: "image/png", declaredSize: 3 },
    rotated: { fileId: "native-id", fileName: "image.png", mimeType: "image/png", declaredSize: 3 },
    opened: false,
    code: "INVALID_NATIVE_SOURCE",
    status: 400,
  });
});

test.each([
  ["contradicting header", "3", "[Buffer.from([1,2,3])]", false],
  ["short body", "null", "[Buffer.from([1,2,3])]", true],
  ["oversized body", "4", "[Buffer.from([1,2,3,4,5])]", true],
  ["non-byte chunk", "4", "['text']", true],
])(
  "trusted source transport cannot bypass %s validation or closure",
  async (_kind, length, chunks, bodyRead) => {
    const result = await child(`
    import {nativeFileBytes} from ${JSON.stringify(source)};
    const file={fileId:'native-id',downloadUrl:'https://files.oaiusercontent.com/object?sig=private',declaredSize:4};
    let closed=false,read=false,code,status;
    try{const opened=await nativeFileBytes(file,{sourceOpener:async()=>({
      contentLength:${length},mimeType:'application/octet-stream',
      body:(async function*(){read=true;yield* ${chunks}})(),close:async()=>{closed=true}
    })});for await(const chunk of opened.body){void chunk}}
    catch(error){code=error.publicCode;status=error.status}
    console.log(JSON.stringify({closed,read,code,status}));
  `);
    expect(result).toEqual({ closed: true, read: bodyRead, code: "SOURCE_REFUSED", status: 422 });
  },
);

test("common native byte consumption and explicit cancellation await source physical settlement", async () => {
  const result = await child(`
    import {nativeFileBytes} from ${JSON.stringify(source)};
    const file={fileId:'native-id',downloadUrl:'https://files.oaiusercontent.com/object?sig=private',declaredSize:3};
    let releaseClose,closeRequested,releaseSettled;
    const closing=new Promise(done=>{closeRequested=done});
    const closeGate=new Promise(done=>{releaseClose=done});
    const physical=new Promise(done=>{releaseSettled=done});
    const abort=new AbortController();
    const opened=await nativeFileBytes(file,{signal:abort.signal,sourceOpener:async()=>({
      contentLength:3,mimeType:'image/png',body:(async function*(){yield Buffer.from([0,255,128])})(),
      close:async()=>{closeRequested();await closeGate},settled:physical
    })});
    let finished=false;const bytes=[];
    const reading=(async()=>{for await(const chunk of opened.body)bytes.push(...chunk)})().then(()=>{finished=true});
    await closing;abort.abort();await Promise.resolve();const beforeClose=finished;
    releaseClose();await Promise.resolve();await Promise.resolve();const beforeSettlement=finished;
    releaseSettled();await reading;await opened.close();await opened.settled;
    console.log(JSON.stringify({bytes,mimeType:opened.mimeType,beforeClose,beforeSettlement,finished}));
  `);
  expect(result).toEqual({
    bytes: [0, 255, 128],
    mimeType: "image/png",
    beforeClose: false,
    beforeSettlement: false,
    finished: true,
  });
});
