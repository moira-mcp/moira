const { beforeAll, afterAll, test, expect } = require("@jest/globals");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:https");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

let directory;
let key;
let ca;
const helper = pathToFileURL(resolve("scripts/acquire-pinned-archive.js")).href;
const bytes = Buffer.alloc(2 * 1024 * 1024, 173);

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "moira-pinned-archive-"));
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

async function acquire(input, trusted = true) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { acquirePinnedArchive } = await import(process.argv[1]);
    try { const path = await acquirePinnedArchive(JSON.parse(process.argv[2]));
      console.log(JSON.stringify({path}));
    } catch (error) { console.log(JSON.stringify({error:error.message})); }
  `,
      helper,
      JSON.stringify(input),
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? ca : "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(Buffer.concat(errors).toString());
  return JSON.parse(Buffer.concat(output).toString());
}

async function fixture(run) {
  const requests = [];
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(ca) },
    async (req, res) => {
      requests.push(req.url);
      if (req.url === "/redirect") return res.writeHead(302, { location: "/archive" }).end();
      if (req.url === "/downgrade")
        return res.writeHead(302, { location: "http://127.0.0.1/archive" }).end();
      if (req.url === "/loop") return res.writeHead(307, { location: "/loop" }).end();
      if (req.url === "/missing") return res.writeHead(404).end();
      res.writeHead(200, { "content-length": bytes.length });
      if (req.url === "/truncated") {
        res.write(bytes.subarray(0, 1024));
        setImmediate(() => res.destroy());
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        if (!res.write(bytes.subarray(offset, offset + 16384))) await once(res, "drain");
      }
      res.end();
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const cache = mkdtempSync(join(directory, "cache-"));
  const target = join(cache, "archive");
  const origin = `https://127.0.0.1:${server.address().port}`;
  const input = {
    target,
    algorithm: "sha256",
    encoding: "hex",
    expected: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    await run({ origin, input, cache, target, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

test.each([
  ["sha256", "hex"],
  ["sha512", "base64"],
])(
  "streams a verified redirect and reuses only matching %s cache bytes",
  async (algorithm, encoding) =>
    fixture(async ({ origin, input, cache, target, requests }) => {
      Object.assign(input, {
        algorithm,
        encoding,
        expected: createHash(algorithm).update(bytes).digest(encoding),
      });
      expect(await acquire({ ...input, url: `${origin}/redirect` })).toEqual({ path: target });
      expect(readFileSync(target)).toEqual(bytes);
      expect(readdirSync(cache)).toEqual(["archive"]);
      expect(await acquire({ ...input, url: `${origin}/missing` })).toEqual({ path: target });
      expect(requests).toEqual(["/redirect", "/archive"]);
    }),
);

test.each(["truncated", "missing", "downgrade", "loop"])(
  "refuses %s without publishing or retaining candidate bytes",
  async (route) =>
    fixture(async ({ origin, input, cache, requests }) => {
      expect(await acquire({ ...input, url: `${origin}/${route}` })).toEqual({
        error: expect.any(String),
      });
      expect(readdirSync(cache)).toEqual([]);
      expect(requests).toHaveLength(route === "loop" ? 21 : 1);
    }),
);

test("a complete wrong-pin response is removed; an existing corrupt cache is never replaced", async () => {
  await fixture(async ({ origin, input, cache, target, requests }) => {
    const wrongPin = { ...input, expected: "0".repeat(64), url: `${origin}/archive` };
    expect(await acquire(wrongPin)).toEqual({
      error: "Downloaded archive failed its pinned integrity",
    });
    expect(readdirSync(cache)).toEqual([]);
    writeFileSync(target, "preserve corrupt cache for diagnosis");
    expect(await acquire({ ...input, url: `${origin}/archive` })).toEqual({
      error: "Cached archive failed its pinned integrity",
    });
    expect(readFileSync(target, "utf8")).toBe("preserve corrupt cache for diagnosis");
    expect(requests).toEqual(["/archive"]);
    expect(readdirSync(cache)).toEqual(["archive"]);
  });
});

test("an untrusted TLS certificate cannot install a pinned archive", async () => {
  await fixture(async ({ origin, input, cache, requests }) => {
    expect(await acquire({ ...input, url: `${origin}/archive` }, false)).toEqual({
      error: expect.any(String),
    });
    expect(requests).toEqual([]);
    expect(readdirSync(cache)).toEqual([]);
  });
});
