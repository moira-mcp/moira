import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { extract } from "tar-stream";
import { DatabaseError } from "@mcp-moira/shared";
import {
  AgentMessageQueue,
  createMaterializeTar,
  GraphValidator,
  InMemoryRepository,
  MaterializeHandler,
  MATERIALIZE_MAX_FILE_BYTES,
  MATERIALIZE_MAX_FILES,
  MATERIALIZE_MAX_TOTAL_BYTES,
  quotePosixShellArgument,
  renderMaterializeFiles,
  UniversalGraphExecutor,
  type ExecutionContext,
  type INodeHandler,
  type MaterializeNode,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const context: ExecutionContext = {
  executionId: "execution-1",
  workflowId: "workflow-1",
  userId: "user-1",
  variables: { name: "Moira", folder: "generated" },
  nodeStates: {},
};

const node: MaterializeNode = {
  type: "materialize",
  id: "materialize",
  basePath: "./output/{{folder}}",
  files: [{ path: "README.md", from: "readme" }],
  connections: { success: "end" },
};

const registry = {
  readme: { type: "string", description: "README source", default: "# {{name}}" },
  name: { type: "string", description: "Name", default: "default name" },
  folder: { type: "string", description: "Destination folder", default: "generated" },
};

async function untar(buffer: Buffer): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const parser = extract();
  const completed = new Promise<void>((resolve, reject) => {
    parser.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => {
        result.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.once("error", reject);
      stream.resume();
    });
    parser.once("finish", resolve);
    parser.once("error", reject);
  });
  parser.end(buffer);
  await completed;
  return result;
}

function readCapturedArgv(path: string): string[] {
  return readFileSync(path).toString("utf8").split("\0").slice(0, -1);
}

describe("materialize node", () => {
  test("schema accepts the canonical skeleton and rejects inline content", async () => {
    const completeNode = {
      ...node,
      files: [
        { path: "README.md", from: "readme" },
        { path: "plans/.keep", content: "" as const },
      ],
    };
    const workflow = {
      metadata: { name: "Test", version: "1.0.0", description: "Test" },
      variableRegistry: registry,
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        completeNode,
        { id: "end", type: "end" },
      ],
    };
    expect((await new GraphValidator().validateUnified(workflow)).valid).toBe(true);

    const exactCount = structuredClone(workflow);
    exactCount.nodes[1].files = Array.from({ length: MATERIALIZE_MAX_FILES }, (_, index) => ({
      path: `${index}.txt`,
      from: "readme",
    }));
    expect((await new GraphValidator().validateUnified(exactCount)).valid).toBe(true);
    const overCount = structuredClone(exactCount);
    overCount.nodes[1].files.push({ path: "overflow.txt", from: "readme" });
    expect((await new GraphValidator().validateUnified(overCount)).valid).toBe(false);

    const inlineContent = structuredClone(workflow);
    inlineContent.nodes[1].files = [{ path: "inline", content: "inline data" }];
    const inlineResult = await new GraphValidator().validateUnified(inlineContent);
    expect(inlineResult.valid).toBe(false);
    expect(inlineResult.issues.some((issue) => JSON.stringify(issue).includes("content"))).toBe(
      true,
    );

    const missingSuccess = structuredClone(workflow);
    missingSuccess.nodes[1].connections = {};
    const connectionResult = await new GraphValidator().validateUnified(missingSuccess);
    expect(connectionResult.valid).toBe(false);
    expect(connectionResult.issues.some((issue) => issue.message.includes("success"))).toBe(true);

    const unknownBase = structuredClone(workflow);
    unknownBase.nodes[1].basePath = "{{unknownBase}}";
    const unknownBaseResult = await new GraphValidator().validateUnified(unknownBase);
    expect(unknownBaseResult.valid).toBe(false);
    expect(unknownBaseResult.issues.some((issue) => issue.field === "basePath")).toBe(true);

    const unknownPath = structuredClone(workflow);
    unknownPath.nodes[1].files = [{ path: "{{unknownPath}}", from: "readme" }];
    const unknownPathResult = await new GraphValidator().validateUnified(unknownPath);
    expect(unknownPathResult.valid).toBe(false);
    expect(unknownPathResult.issues.some((issue) => issue.field === "files[0].path")).toBe(true);

    const missingDefault = structuredClone(workflow);
    Reflect.deleteProperty(missingDefault.variableRegistry.readme, "default");
    const missingDefaultResult = await new GraphValidator().validateUnified(missingDefault);
    expect(missingDefaultResult.valid).toBe(false);
    expect(
      missingDefaultResult.issues.some(
        (issue) => issue.field === "files[0].from" && issue.message.includes("string default"),
      ),
    ).toBe(true);

    const nonStringDefault = structuredClone(workflow);
    Object.assign(nonStringDefault.variableRegistry, {
      readme: {
        type: "number",
        description: "Invalid materialize source",
        default: 42,
      },
    });
    const nonStringDefaultResult = await new GraphValidator().validateUnified(nonStringDefault);
    expect(nonStringDefaultResult.valid).toBe(false);
    expect(
      nonStringDefaultResult.issues.some(
        (issue) => issue.field === "files[0].from" && issue.message.includes("type string"),
      ),
    ).toBe(true);

    for (const files of [
      [{ path: "/absolute", from: "readme" }],
      [{ path: "\\absolute", from: "readme" }],
      [{ path: "nul\0name", from: "readme" }],
      [{ path: "double//segment", from: "readme" }],
      [{ path: "nested/./file", from: "readme" }],
      [{ path: "nested/../escape", from: "readme" }],
      [
        { path: "same", from: "readme" },
        { path: "same", content: "" },
      ],
      [
        { path: "dir\\same", from: "readme" },
        { path: "dir/same", content: "" },
      ],
      [{ path: "missing-source" }],
      [{ path: "both", from: "readme", content: "" }],
      [{ path: "unknown", from: "undeclared" }],
    ]) {
      const candidate = structuredClone(workflow);
      candidate.nodes[1].files = files;
      expect((await new GraphValidator().validateUnified(candidate)).valid).toBe(false);
    }
  });

  test("renders registry source, a large Markdown template, and a valid tar", async () => {
    const markdownBody = `# Engineering standards

- outer item
  - nested item for {{name}}

Owner's guide — Привет, мир 🚀
Literal template example: \\{{literal_example}}
Execution: {{executionId}}
Runtime data stays literal: {{runtimeSnippet}}

\`\`\`ts
const owner = "{{name}}";
\`\`\`

`;
    const nestedTemplate = `{{#each tasks}}{{#if done}}- [x] {{title}}{{else}}- [ ] {{title}}{{/if}}
{{/each}}
`;
    const renderedBody = `# Engineering standards

- outer item
  - nested item for Moira

Owner's guide — Привет, мир 🚀
Literal template example: {{literal_example}}
Execution: execution-1
Runtime data stays literal: {{executionId}}

\`\`\`ts
const owner = "Moira";
\`\`\`

`;
    const largeMarkdown = `${markdownBody.repeat(220)}${nestedTemplate}`;
    const expectedMarkdown = `${renderedBody.repeat(220)}- [x] preserve Markdown
- [ ] ship release

`;
    expect(Buffer.byteLength(largeMarkdown)).toBeGreaterThan(19 * 1024);
    const files = await renderMaterializeFiles(
      {
        ...node,
        files: [
          { path: "{{folder}}/large.md", from: "large" },
          { path: "plans/.keep", content: "" },
        ],
      },
      {
        ...registry,
        large: { type: "string", description: "Large source", default: largeMarkdown },
      },
      {
        ...context,
        variables: {
          ...context.variables,
          tasks: [
            { title: "preserve Markdown", done: true },
            { title: "ship release", done: false },
          ],
          runtimeSnippet: "{{executionId}}",
        },
      },
    );
    expect(files[0].path).toBe("generated/large.md");
    expect(files[0].content.toString()).toBe(expectedMarkdown);
    expect(files[1].content).toHaveLength(0);

    const archive = await untar(await createMaterializeTar(files));
    expect(archive.get("generated/large.md")?.toString()).toBe(files[0].content.toString());
    expect(archive.get("plans/.keep")).toHaveLength(0);
  });

  test("rejects raw traversal, rendered traversal, and rendered collisions", async () => {
    for (const unsafe of [
      "../secret",
      ".",
      "\\absolute",
      "nul\0name",
      "double//segment",
      "nested/./file",
    ]) {
      await expect(
        renderMaterializeFiles(
          { ...node, files: [{ path: unsafe, from: "readme" }] },
          registry,
          context,
        ),
      ).rejects.toThrow(/unsafe path|relative path/);
      await expect(
        renderMaterializeFiles(
          { ...node, files: [{ path: "{{unsafe}}", from: "readme" }] },
          registry,
          { ...context, variables: { ...context.variables, unsafe } },
        ),
      ).rejects.toThrow(/unsafe path|relative path/);
    }
    await expect(
      renderMaterializeFiles(
        {
          ...node,
          files: [
            { path: "{{same}}", from: "readme" },
            { path: "same.md", from: "readme" },
          ],
        },
        registry,
        { ...context, variables: { ...context.variables, same: "same.md" } },
      ),
    ).rejects.toThrow("collision");
  });

  test("enforces exact file count, per-file, and aggregate limits", async () => {
    const atCount = Array.from({ length: MATERIALIZE_MAX_FILES }, (_, index) => ({
      path: `${index}.txt`,
      from: "small",
    }));
    await expect(
      renderMaterializeFiles(
        { ...node, files: atCount },
        { small: { type: "string", description: "small", default: "x" } },
        context,
      ),
    ).resolves.toHaveLength(MATERIALIZE_MAX_FILES);
    await expect(
      renderMaterializeFiles(
        { ...node, files: [...atCount, { path: "overflow.txt", from: "small" }] },
        { small: { type: "string", description: "small", default: "x" } },
        context,
      ),
    ).rejects.toThrow(`${MATERIALIZE_MAX_FILES}`);

    const exact = "x".repeat(MATERIALIZE_MAX_FILE_BYTES);
    await expect(
      renderMaterializeFiles(
        { ...node, files: [{ path: "exact", from: "exact" }] },
        { exact: { type: "string", description: "exact", default: exact } },
        context,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      renderMaterializeFiles(
        { ...node, files: [{ path: "overflow", from: "overflow" }] },
        { overflow: { type: "string", description: "overflow", default: `${exact}x` } },
        context,
      ),
    ).rejects.toThrow(`${MATERIALIZE_MAX_FILE_BYTES}`);

    const aggregateFiles = Array.from({ length: 10 }, (_, index) => ({
      path: `${index}.bin`,
      from: "exact",
    }));
    await expect(
      renderMaterializeFiles(
        { ...node, files: aggregateFiles },
        { exact: { type: "string", description: "exact", default: exact } },
        context,
      ),
    ).resolves.toHaveLength(10);
    expect(10 * MATERIALIZE_MAX_FILE_BYTES).toBe(MATERIALIZE_MAX_TOTAL_BYTES);
    await expect(
      renderMaterializeFiles(
        { ...node, files: [...aggregateFiles, { path: "overflow.bin", from: "exact" }] },
        { exact: { type: "string", description: "exact", default: exact } },
        context,
      ),
    ).rejects.toThrow(`${MATERIALIZE_MAX_TOTAL_BYTES}`);
  });

  test("shell-quotes every dynamic argument and exposes a closed completion schema", async () => {
    const grants = {
      createMaterializeToken: () => "tok'en",
    };
    const handler = new MaterializeHandler(grants, () => "https://moira.example/base'");
    const queue = new AgentMessageQueue();
    const hostileBasePath = "-dash with spaces/$(printf injected);\nline 'quoted'";
    const result = await handler.execute(
      { ...node, basePath: hostileBasePath },
      context,
      queue,
      {} as never,
      {} as never,
    );
    expect(result.action).toBe("pause");
    const message = queue.flush("execution-1").messages[0];
    expect(message.type).toBe("directive");
    if (message.type !== "directive") throw new Error("Expected directive");
    expect(message.directive).toContain(quotePosixShellArgument(hostileBasePath));
    expect(message.directive).toContain(
      quotePosixShellArgument(
        "https://moira.example/base'/api/public/executions/materialize/tok'en",
      ),
    );
    expect(message.directive).toContain("mkdir -p --");
    expect(message.directive).toContain("curl -sSf --");
    expect(message.directive).toContain("Materialize 1 file into");
    expect(message.directive).toContain(JSON.stringify(hostileBasePath));
    expect(message.directive).toContain('Files:\n- "README.md"');
    expect(message.directive).toContain("the contents never pass through your context");
    expect(message.directive).not.toContain("# {{name}}");
    expect(message.inputSchema).toEqual({
      type: ["object", "null"],
      additionalProperties: false,
      maxProperties: 0,
    });
    expect(quotePosixShellArgument("a'b")).toBe("'a'\"'\"'b'");
    const shellProbe = spawnSync(
      "/bin/sh",
      ["-c", `set -- ${quotePosixShellArgument(hostileBasePath)}; printf '%s' "$#:$1"`],
      { encoding: "utf8" },
    );
    expect(shellProbe.status).toBe(0);
    expect(shellProbe.stdout).toBe(`1:${hostileBasePath}`);

    const captureDirectory = mkdtempSync(join(tmpdir(), "moira-materialize-shell-"));
    try {
      const exactCommand = `mkdir -p -- ${quotePosixShellArgument(hostileBasePath)} && curl -sSf -- ${quotePosixShellArgument("https://moira.example/base'/api/public/executions/materialize/tok'en")} | tar -x -C ${quotePosixShellArgument(hostileBasePath)}`;
      expect(message.directive).toContain(exactCommand);
      const shellHarness = `
        CAP=$1
        capture() {
          file=$1
          shift
          : > "$CAP/$file.argv"
          for argument; do
            printf '%s\\0' "$argument" >> "$CAP/$file.argv"
          done
        }
        mkdir() { capture mkdir "$@"; }
        curl() { capture curl "$@"; printf archive; }
        tar() {
          capture tar "$@"
          while IFS= read -r _line; do :; done
        }
        ${exactCommand}
      `;
      const completeCommand = spawnSync(
        "/bin/sh",
        ["-c", shellHarness, "materialize-shell", captureDirectory],
        { encoding: "utf8" },
      );
      expect(completeCommand.status).toBe(0);
      expect(completeCommand.stderr).toBe("");
      expect(readCapturedArgv(join(captureDirectory, "mkdir.argv"))).toEqual([
        "-p",
        "--",
        hostileBasePath,
      ]);
      expect(readCapturedArgv(join(captureDirectory, "curl.argv"))).toEqual([
        "-sSf",
        "--",
        "https://moira.example/base'/api/public/executions/materialize/tok'en",
      ]);
      expect(readCapturedArgv(join(captureDirectory, "tar.argv"))).toEqual([
        "-x",
        "-C",
        hostileBasePath,
      ]);
    } finally {
      rmSync(captureDirectory, { recursive: true, force: true });
    }
    await expect(
      handler.execute(node, context, new AgentMessageQueue(), {} as never, {} as never, null),
    ).resolves.toMatchObject({ action: "continue", outputPath: "success" });

    const objectContext = { ...context, nodeStates: {} };
    await handler.execute(node, objectContext, new AgentMessageQueue(), {} as never, {} as never);
    await expect(
      handler.execute(node, objectContext, new AgentMessageQueue(), {} as never, {} as never, {}),
    ).resolves.toMatchObject({ action: "continue", outputPath: "success" });

    const invalidContext = { ...context, nodeStates: {} };
    await handler.execute(node, invalidContext, new AgentMessageQueue(), {} as never, {} as never);
    await expect(
      handler.execute(node, invalidContext, new AgentMessageQueue(), {} as never, {} as never, {
        extra: true,
      }),
    ).rejects.toThrow("null or {}");
  });

  test("rejects an empty or NUL-bearing rendered base path before issuing a grant", async () => {
    let grants = 0;
    const handler = new MaterializeHandler(
      {
        createMaterializeToken: () => {
          grants++;
          return "unused";
        },
      },
      () => "https://moira.example",
    );
    for (const invalidBase of ["", "bad\0path"]) {
      const invalidContext = {
        ...context,
        variables: { ...context.variables, invalidBase },
      };
      await expect(
        handler.execute(
          { ...node, basePath: "{{invalidBase}}", connections: { success: "end" } },
          invalidContext,
          new AgentMessageQueue(),
          {} as never,
          {} as never,
        ),
      ).rejects.toThrow(/non-empty|NUL/);
      await expect(
        handler.execute(
          {
            ...node,
            basePath: "{{invalidBase}}",
            connections: { success: "end", error: "recover" },
          },
          invalidContext,
          new AgentMessageQueue(),
          {} as never,
          {} as never,
        ),
      ).resolves.toMatchObject({ action: "continue", outputPath: "error" });
    }
    expect(grants).toBe(0);
  });

  test("direct re-entry without a waiting marker issues a fresh grant", async () => {
    const workflow: WorkflowGraph = {
      id: "workflow-1",
      metadata: { name: "Re-entry", version: "1.0.0", description: "Re-entry" },
      variableRegistry: registry,
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        node,
        { id: "end", type: "end" },
      ],
    };
    const repository = new InMemoryRepository();
    await repository.saveWorkflow(workflow, "user-1");
    const executor = new UniversalGraphExecutor(repository);
    const graphEngine = (
      executor as unknown as { graphEngine: { nodeHandlers: Map<string, MaterializeHandler> } }
    ).graphEngine;
    let grants = 0;
    graphEngine.nodeHandlers.set(
      "materialize",
      new MaterializeHandler(
        {
          createMaterializeToken: () => {
            grants++;
            return "fresh-reentry-token";
          },
        },
        () => "https://moira.example",
      ),
    );
    const executionId = await executor.startWorkflow(workflow, undefined, "user-1");
    const reentered = await repository.getExecution(executionId);
    if (!reentered) throw new Error("Expected seeded execution");
    reentered.currentNodeId = "materialize";
    reentered.waitingForInputNodeId = null;
    await repository.saveExecution(reentered);

    const directive = await executor.executeStep(executionId);
    expect(directive).toContain("fresh-reentry-token");
    expect(grants).toBe(1);
    const waiting = await repository.getExecution(executionId);
    expect(waiting?.currentNodeId).toBe("materialize");
    expect(waiting?.waitingForInputNodeId).toBe("materialize");
  });

  test("re-presentation never follows a materialize error connection", async () => {
    const workflow: WorkflowGraph = {
      id: "workflow-presentation-error",
      metadata: {
        name: "Presentation error isolation",
        version: "1.0.0",
        description: "Presentation error isolation",
      },
      variableRegistry: registry,
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        { ...node, connections: { success: "end", error: "recover" } },
        {
          id: "recover",
          type: "agent-directive",
          directive: "Recovery must not execute during presentation",
          completionCondition: "Never reached",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    const repository = new InMemoryRepository();
    await repository.saveWorkflow(workflow, "user-1");
    const executor = new UniversalGraphExecutor(repository);
    const graphEngine = (
      executor as unknown as { graphEngine: { nodeHandlers: Map<string, INodeHandler> } }
    ).graphEngine;
    let firstGrant = true;
    graphEngine.nodeHandlers.set(
      "materialize",
      new MaterializeHandler(
        {
          createMaterializeToken: () => {
            if (!firstGrant) {
              throw new DatabaseError("grant repository unavailable");
            }
            firstGrant = false;
            return "presentation-token";
          },
        },
        () => "https://moira.example",
      ),
    );

    const executionId = await executor.startWorkflow(workflow, undefined, "user-1");
    await expect(executor.executeStep(executionId)).resolves.toContain("presentation-token");
    const beforePresentation = await repository.getExecution(executionId);
    expect(beforePresentation).toMatchObject({
      currentNodeId: "materialize",
      waitingForInputNodeId: "materialize",
    });

    graphEngine.nodeHandlers.set("agent-directive", {
      getNodeType: () => "agent-directive",
      execute: async () => {
        throw new Error("materialize error successor was executed");
      },
    });

    await expect(executor.presentCurrentStep(executionId)).rejects.toThrow(
      "Materialize node 'materialize' could not be presented: grant repository unavailable",
    );
    await expect(repository.getExecution(executionId)).resolves.toEqual(beforePresentation);
  });

  test("runs start → materialize pause → empty completion → successor", async () => {
    const workflow: WorkflowGraph = {
      id: "workflow-1",
      metadata: { name: "Scenario", version: "1.0.0", description: "Scenario" },
      variableRegistry: registry,
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        {
          ...node,
          files: [
            { path: "README.md", from: "readme" },
            { path: "plans/.keep", content: "" },
          ],
        },
        { id: "end", type: "end" },
      ],
    };
    const repository = new InMemoryRepository();
    await repository.saveWorkflow(workflow, "user-1");
    const executor = new UniversalGraphExecutor(repository);
    const graphEngine = (
      executor as unknown as { graphEngine: { nodeHandlers: Map<string, MaterializeHandler> } }
    ).graphEngine;
    const handlers = graphEngine.nodeHandlers;
    handlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => "scenario-token" },
        () => "https://moira.example",
      ),
    );
    const executionId = await executor.startWorkflow(workflow, undefined, "user-1");
    const paused = await executor.executeStep(executionId);
    expect(paused).toContain("scenario-token");
    expect(paused).toContain("Materialize 2 files into");
    expect(paused).toContain('Files:\n- "README.md"\n- "plans/.keep"');
    expect(paused).not.toContain("# {{name}}");
    const waiting = await repository.getExecution(executionId);
    expect(waiting?.waitingForInputNodeId).toBe("materialize");
    expect(waiting?.globalContext.variables.materialize).toBeUndefined();
    expect(JSON.stringify(waiting?.globalContext)).not.toContain("scenario-token");

    const rejected = await executor.executeStep(executionId, { extra: true });
    expect(rejected).toContain("VALIDATION ERROR");
    const stillWaiting = await repository.getExecution(executionId);
    expect(stillWaiting?.currentNodeId).toBe("materialize");
    expect(stillWaiting?.waitingForInputNodeId).toBe("materialize");

    const completed = await executor.executeStep(executionId);
    expect(completed).toContain("Workflow completed successfully");
  });

  test("only expected preparation failures follow the optional error edge", async () => {
    const handler = new MaterializeHandler(
      {
        createMaterializeToken: () => {
          throw new DatabaseError("grant failed");
        },
      },
      () => "https://moira.example",
    );
    await expect(
      handler.execute(
        { ...node, connections: { success: "end", error: "recover" } },
        context,
        new AgentMessageQueue(),
        {} as never,
        {} as never,
      ),
    ).resolves.toMatchObject({ action: "continue", outputPath: "error" });

    const programmerFailure = new MaterializeHandler(
      {
        createMaterializeToken: () => {
          throw new Error("unexpected programmer defect");
        },
      },
      () => "https://moira.example",
    );
    await expect(
      programmerFailure.execute(
        { ...node, connections: { success: "end", error: "recover" } },
        context,
        new AgentMessageQueue(),
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow("unexpected programmer defect");
  });
});
