const { test, expect } = require("@jest/globals");
const {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  rmSync,
  symlinkSync,
  linkSync,
  chmodSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const moduleUrl = pathToFileURL(
  resolve("packages/workspace-service/src/daemon-diagnostics.mjs"),
).href;
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "moira-daemon-diagnostics-")));
const names = ["daemon.log.2", "daemon.log.1", "daemon.log"];

test("one oversized diagnostic write rotates the actual writer into bounded private files and retains the latest bytes", async () => {
  const { openDaemonDiagnostics, DAEMON_DIAGNOSTIC_FILE_BYTES: budget } = await import(moduleUrl);
  const directory = fixture();
  const bytes = Buffer.concat([
    Buffer.alloc(budget, "a"),
    Buffer.alloc(budget, "b"),
    Buffer.alloc(budget, "c"),
    Buffer.from("latest diagnostic\n"),
  ]);
  const sink = openDaemonDiagnostics(directory);
  try {
    sink.write(bytes);
    expect(Buffer.concat(names.map((name) => readFileSync(join(directory, name))))).toEqual(
      bytes.subarray(budget),
    );
    expect(readdirSync(directory).sort()).toEqual([...names].sort());
    for (const name of names) {
      const value = statSync(join(directory, name));
      expect(value.size).toBeLessThanOrEqual(budget);
      expect(value.mode & 0o777).toBe(0o600);
      expect(value.nlink).toBe(1);
    }
    sink.write("after rotation\n");
    expect(readFileSync(join(directory, "daemon.log"), "utf8")).toBe(
      "latest diagnostic\nafter rotation\n",
    );
  } finally {
    sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart bounds pre-existing oversized diagnostics and archives before adding new bytes", async () => {
  const { openDaemonDiagnostics, DAEMON_DIAGNOSTIC_FILE_BYTES: budget } = await import(moduleUrl);
  const directory = fixture();
  try {
    for (const [index, name] of names.entries())
      writeFileSync(join(directory, name), Buffer.alloc(budget * 2, 65 + index), { mode: 0o600 });
    const sink = openDaemonDiagnostics(directory);
    try {
      for (const [index, name] of names.entries())
        expect(readFileSync(join(directory, name))).toEqual(Buffer.alloc(budget, 65 + index));
      sink.write("restarted\n");
      expect(readFileSync(join(directory, "daemon.log"), "utf8")).toBe("restarted\n");
      expect(
        names.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0),
      ).toBeLessThanOrEqual(budget * 3);
    } finally {
      sink.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["symlink", "hardlink", "public-file", "public-directory"])(
  "unsafe %s diagnostic storage refuses before touching retained or foreign bytes",
  async (kind) => {
    const { openDaemonDiagnostics } = await import(moduleUrl);
    const directory = fixture(),
      foreign = fixture();
    try {
      const target = join(foreign, "foreign");
      writeFileSync(target, "foreign bytes", { mode: 0o600 });
      writeFileSync(join(directory, "daemon.log"), "previous diagnostics", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, join(directory, "daemon.log.2"));
      if (kind === "hardlink") linkSync(target, join(directory, "daemon.log.2"));
      if (kind === "public-file") {
        writeFileSync(join(directory, "daemon.log.2"), "public diagnostics");
        chmodSync(join(directory, "daemon.log.2"), 0o644);
      }
      if (kind === "public-directory") chmodSync(directory, 0o755);
      expect(() => openDaemonDiagnostics(directory)).toThrow();
      expect(readFileSync(target, "utf8")).toBe("foreign bytes");
      expect(readFileSync(join(directory, "daemon.log"), "utf8")).toBe("previous diagnostics");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  },
);

test("the owned daemon stream boundary captures ready, failure and actual Node warnings without inherited output", () => {
  const directory = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {openDaemonDiagnostics} from ${JSON.stringify(moduleUrl)};
      const sink=openDaemonDiagnostics(${JSON.stringify(directory)});
      const restore=sink.redirectStandardStreams();
      process.stdout.write(JSON.stringify({workspaceService:'ready'})+'\\n');
      process.stderr.write(JSON.stringify({error:'WORKSPACE_SERVICE_UNAVAILABLE'})+'\\n');
      process.emitWarning('actual Node diagnostic',{code:'MOIRA_DIAGNOSTIC_FIXTURE'});
      await new Promise(setImmediate);
      restore();sink.close();
    `,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const bytes = readFileSync(join(directory, "daemon.log"), "utf8");
    expect(bytes).toContain('"workspaceService":"ready"');
    expect(bytes).toContain('"error":"WORKSPACE_SERVICE_UNAVAILABLE"');
    expect(bytes).toContain("MOIRA_DIAGNOSTIC_FIXTURE");
    expect(bytes).toContain("actual Node diagnostic");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replacement of the active log fails closed without an inherited stdout or stderr fallback", () => {
  const directory = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs';
      import {openDaemonDiagnostics} from ${JSON.stringify(moduleUrl)};
      const sink=openDaemonDiagnostics(${JSON.stringify(directory)});
      sink.redirectStandardStreams();
      fs.renameSync(${JSON.stringify(join(directory, "daemon.log"))},${JSON.stringify(join(directory, "original"))});
      fs.writeFileSync(${JSON.stringify(join(directory, "daemon.log"))},'replacement',{mode:0o600});
      process.stderr.write('must not escape');
    `,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(join(directory, "daemon.log"), "utf8")).toBe("replacement");
    expect(readFileSync(join(directory, "original"), "utf8")).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
