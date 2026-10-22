import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createWorkflowCliFixture } from "../../helpers/workflow-cli-fixture.js";

function workflow() {
  return {
    metadata: { name: "CLI contract", description: "Isolated fixture", version: "1.0.0" },
    variableRegistry: {
      result: {
        type: "string",
        description: "Result",
        enum: ["first", "second", ""],
        default: "first",
      },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        directive: "Work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

describe("workflow CLI persisted contracts", () => {
  let fixture: ReturnType<typeof createWorkflowCliFixture>;

  beforeEach(() => {
    fixture = createWorkflowCliFixture();
  });

  afterEach(() => fixture.cleanup());

  function write(name: string, value: object): string {
    const file = fixture.path(name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  }

  function compare(before: object, after: object): string {
    const left = write("before.json", before);
    const right = write("after.json", after);
    return stripVTControlCharacters(fixture.run([left, "diff", right]));
  }

  test.each(["--force", "--no-version-bump"])(
    "%s never becomes part of a variable default, including an explicit empty default",
    (flag) => {
      const original = workflow();
      const file = write("workflow.json", original);
      for (const value of ["second", ""]) {
        fixture.run([file, "set-variable", "result", value, flag]);
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(saved.variableRegistry.result).toEqual({
          ...original.variableRegistry.result,
          default: value,
        });
        expect(saved.metadata.version).toBe("1.0.0");
      }
    },
  );

  test("the alternate directive value accepts explicit empty text", () => {
    const file = write("workflow.json", workflow());
    fixture.run([file, "set-variable", "result", "--directive", "", "--force"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).variableRegistry.result.default).toBe("");
  });

  test.each<[string, string[]]>([
    ["no value", []],
    ["only force", ["--force"]],
    ["only no-version-bump", ["--no-version-bump"]],
    ["directive without value", ["--directive"]],
    ["directive followed by a switch", ["--directive", "--force"]],
    ["directive file without a path", ["--directive-file"]],
    ["directive file followed by a switch", ["--directive-file", "--force"]],
  ])("refuses %s without changing input bytes", (_label, arguments_) => {
    const file = write("workflow.json", workflow());
    const before = fs.readFileSync(file);
    expect(() => fixture.run([file, "set-variable", "result", ...arguments_])).toThrow();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test.each<[string, object]>([
    ["progress", { progress: { nodes: [{ id: "work", label: "Work" }] } }],
    [
      "variableRegistry",
      { variableRegistry: { result: { type: "integer", description: "Count" } } },
    ],
    ["runtimePolicy", { runtimePolicy: { externalVariableWrites: { result: {} } } }],
    ["slug", { slug: "new-slug" }],
  ])("diff reports a change only in root %s", (field, change) => {
    const before = workflow();
    const output = compare(before, { ...before, ...change });
    expect(output).toContain(`${field} changed`);
    expect(output).not.toContain("Workflows are identical");
  });

  test.each<[string, object]>([
    ["expressions", { expressions: ["attempt = attempt + 1"] }],
    ["inputSchema", { inputSchema: { type: "object", properties: {} } }],
    [
      "progressActiveContent",
      { progressActiveContent: { summary: "Working", details: ["Detail"] } },
    ],
    ["config", { config: { text: "Extension payload" } }],
    ["input", { input: { result: "task.result" } }],
  ])("diff reports node %s on addition and removal", (field, change) => {
    const before = workflow();
    const after = {
      ...before,
      nodes: before.nodes.map((node) => (node.id === "task" ? { ...node, ...change } : node)),
    };
    for (const [left, right] of [
      [before, after],
      [after, before],
    ]) {
      expect(compare(left, right)).toMatch(new RegExp(`task:.*${field}`));
    }
  });

  test.each([{ value: null }, { value: [] }, { value: {} }])(
    "diff distinguishes absent root fields from explicit $value",
    ({ value }) => {
      const before = workflow();
      const output = compare(before, { ...before, progress: value });
      expect(output).toContain("progress changed");
      expect(output).not.toContain("Workflows are identical");
    },
  );

  test("diff includes all metadata fields and significant node and expression order", () => {
    const before = workflow();
    expect(
      compare(before, { ...before, metadata: { ...before.metadata, tags: ["new"] } }),
    ).toContain("tags changed");
    expect(compare(before, { ...before, nodes: [...before.nodes].reverse() })).toContain(
      "nodes order changed",
    );
    const withExpressions = (expressions: string[]) => ({
      ...before,
      nodes: before.nodes.map((node) => (node.id === "task" ? { ...node, expressions } : node)),
    });
    expect(
      compare(withExpressions(["a = 1", "b = a"]), withExpressions(["b = a", "a = 1"])),
    ).toMatch(/task:.*expressions/);
  });

  test("diff treats object member order as equal at root and inside a node", () => {
    const before = workflow();
    const after = {
      nodes: before.nodes.map((node) => Object.fromEntries(Object.entries(node).reverse())),
      variableRegistry: before.variableRegistry,
      metadata: Object.fromEntries(Object.entries(before.metadata).reverse()),
    };
    expect(compare(before, after)).toContain("Workflows are identical");
  });

  test("two writes at the same instant retain distinct backups with each exact prior version", () => {
    const file = write("workflow.json", workflow());
    const clock = fixture.path("clock.mjs");
    fs.writeFileSync(
      clock,
      'import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: 1735689600000 });',
    );
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(clock).href}` };
    const first = fs.readFileSync(file);
    fixture.run([file, "set-name", "First edit"], env);
    const second = fs.readFileSync(file);
    fixture.run([file, "set-name", "Second edit"], env);

    const backups = fs.readdirSync(fixture.path("workflow-backups"));
    expect(backups).toHaveLength(2);
    expect(new Set(backups).size).toBe(2);
    const bytes = backups.map((name) => fs.readFileSync(fixture.path(`workflow-backups/${name}`)));
    expect(bytes).toContainEqual(first);
    expect(bytes).toContainEqual(second);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.metadata).toMatchObject({ name: "Second edit", version: "1.0.2" });
  });

  test.each([
    { destinationHasId: true, sourceHasAliases: false },
    { destinationHasId: false, sourceHasAliases: false },
    { destinationHasId: true, sourceHasAliases: true },
    { destinationHasId: false, sourceHasAliases: true },
  ])(
    "sync preserves absent destination catalog identity (id=$destinationHasId, source aliases=$sourceHasAliases)",
    ({ destinationHasId, sourceHasAliases }) => {
      const source = {
        ...workflow(),
        id: "11111111-1111-4111-8111-111111111111",
        slug: "source-flow",
        owner: "system-moira",
        visibility: "public",
        ...(sourceHasAliases ? { previousSlugs: ["old-source-flow"] } : {}),
      };
      const destinationIdentity = destinationHasId
        ? { id: "22222222-2222-4222-8222-222222222222" }
        : {};
      const sourceFile = write("source.json", source);
      const destinationFile = write("destination.json", {
        ...workflow(),
        ...destinationIdentity,
        metadata: { name: "Destination", description: "Old content", version: "0.1.0" },
      });
      const before = fs.readFileSync(destinationFile);

      fixture.run([sourceFile, "sync", destinationFile]);

      const saved = JSON.parse(fs.readFileSync(destinationFile, "utf8"));
      // Catalog aliases select the catalog reader, which migrates unstamped definitions to v1.
      const expected = workflow();
      expect(saved).toEqual({
        ...expected,
        ...destinationIdentity,
        metadata: {
          ...expected.metadata,
          ...(sourceHasAliases ? { schemaVersion: 1 } : {}),
        },
      });
      for (const field of ["slug", "owner", "visibility", "previousSlugs"]) {
        expect(saved).not.toHaveProperty(field);
      }
      expect(Object.hasOwn(saved, "id")).toBe(destinationHasId);
      const backups = fs.readdirSync(fixture.path("workflow-backups"));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(fixture.path(`workflow-backups/${backups[0]}`))).toEqual(before);
      expect(JSON.parse(fs.readFileSync(sourceFile, "utf8"))).toEqual(source);
    },
  );
});
