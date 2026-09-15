/**
 * Playbook references in a workflow definition.
 *
 * A playbook is named, reusable behaviour text. A definition refers to it by name, and the engine
 * resolves that reference while presenting a step — not once when the run starts — so editing a
 * playbook reaches a running execution at its next step. These tests protect that timing, the
 * placeholder a run degrades to when the text cannot be read, and the reference form itself.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { GraphTemplateProcessor } from "@mcp-moira/workflow-engine";
import { collectPlaybookReferences, type PlaybookService } from "@mcp-moira/shared";
import type { ExecutionContext } from "@mcp-moira/workflow-engine";

function mockExecutionContext(variables: Record<string, unknown> = {}): ExecutionContext {
  return {
    executionId: "execution-1",
    workflowId: "workflow-1",
    userId: "user-1",
    variables,
    nodeStates: {},
  } as unknown as ExecutionContext;
}

/** A registry that answers for one owner and one playbook name. */
function playbookServiceWith(content: Map<string, string>): PlaybookService {
  return {
    resolveOwner: jest.fn(async (owner?: string, userId?: string) =>
      owner ? owner.replace(/^@/, "") : (userId ?? null),
    ),
    get: jest.fn(async (_userId: string, ownerId: string, slug: string) => {
      const found = content.get(`${ownerId}/${slug}`);
      return found === undefined ? null : { content: found };
    }),
  } as unknown as PlaybookService;
}

describe("playbook reference form", () => {
  test("reads a plain name, an owner-qualified name, and ignores anything else", () => {
    const references = collectPlaybookReferences(
      "{{playbook:review-standard}} {{playbook:@jane/tone-of-voice}} {{note:not-a-playbook}} {{playbook:Not Valid}}",
    );

    expect(references).toEqual([
      { owner: undefined, name: "review-standard", text: "review-standard" },
      { owner: "@jane", name: "tone-of-voice", text: "@jane/tone-of-voice" },
    ]);
  });

  test("skips an escaped reference, so a document about references is not read as naming them", () => {
    const references = collectPlaybookReferences(
      "Write it as \\{{playbook:review-standard}} to name one; {{playbook:real-one}} is a reference.",
    );

    expect(references.map((reference) => reference.name)).toEqual(["real-one"]);
  });

  test("reports one reference even when it appears repeatedly", () => {
    const references = collectPlaybookReferences(
      "{{playbook:review-standard}} and again {{playbook:review-standard}}",
    );
    expect(references).toHaveLength(1);
  });
});

describe("the bundled catalog", () => {
  test("names no playbook, so every bundled flow still starts", () => {
    // A bundled flow that names a playbook would be unstartable for everyone: no account has it.
    // The authoring guidance inside Workflow Management Flow shows the syntax, and showing is not
    // naming — that distinction is what this check protects.
    const flowsDir = path.join(process.cwd(), "workflows/production/flows");
    const named: string[] = [];

    for (const file of readdirSync(flowsDir).filter((name) => name.endsWith(".json"))) {
      const definition = JSON.parse(readFileSync(path.join(flowsDir, file), "utf-8")) as unknown;
      for (const reference of collectReferencesIn(definition)) {
        named.push(`${file}: ${reference}`);
      }
    }

    expect(named).toEqual([]);
  });

  function collectReferencesIn(value: unknown): string[] {
    if (typeof value === "string") {
      return collectPlaybookReferences(value).map((reference) => reference.text);
    }
    if (Array.isArray(value)) return value.flatMap(collectReferencesIn);
    if (value && typeof value === "object") {
      return Object.values(value).flatMap(collectReferencesIn);
    }
    return [];
  }
});

describe("resolving a playbook reference", () => {
  test("substitutes the playbook's current text", async () => {
    const playbooks = playbookServiceWith(new Map([["user-1/review-standard", "Read the diff."]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const result = await processor.processDirectiveAsync(
      "Follow this: {{playbook:review-standard}}",
      mockExecutionContext(),
    );

    expect(result).toBe("Follow this: Read the diff.");
  });

  test("reads the text again on the next step, so an edit reaches a running execution", async () => {
    const content = new Map([["user-1/review-standard", "First wording."]]);
    const playbooks = playbookServiceWith(content);
    const processor = new GraphTemplateProcessor(undefined, playbooks);
    const context = mockExecutionContext();

    const firstStep = await processor.processDirectiveAsync(
      "{{playbook:review-standard}}",
      context,
    );
    content.set("user-1/review-standard", "Second wording.");
    const nextStep = await processor.processDirectiveAsync("{{playbook:review-standard}}", context);

    expect(firstStep).toBe("First wording.");
    expect(nextStep).toBe("Second wording.");
  });

  test("reads one playbook once however often the step names it", async () => {
    const playbooks = playbookServiceWith(new Map([["user-1/standard", "Text."]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const result = await processor.processDirectiveAsync(
      "{{playbook:standard}} … {{playbook:standard}}",
      mockExecutionContext(),
    );

    expect(result).toBe("Text. … Text.");
    expect((playbooks.get as jest.Mock).mock.calls).toHaveLength(1);
  });

  test("resolves a published playbook of another account by owner", async () => {
    const playbooks = playbookServiceWith(new Map([["jane/tone", "Be plain."]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const result = await processor.processDirectiveAsync(
      "{{playbook:@jane/tone}}",
      mockExecutionContext(),
    );

    expect(result).toBe("Be plain.");
  });

  test("does not let another account's text run as a template in this execution", async () => {
    const playbooks = playbookServiceWith(
      new Map([["jane/tone", "Use {{context.variables}} carefully."]]),
    );
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const result = await processor.processDirectiveAsync(
      "{{playbook:@jane/tone}}",
      mockExecutionContext({ secret: "not for jane" }),
    );

    // The braces arrive as literal text: a published playbook is somebody else's data, and data is
    // never re-read as template syntax.
    expect(result).toBe("Use {{context.variables}} carefully.");
  });

  test("expands your own playbook's templates, because it is your authoring", async () => {
    const playbooks = playbookServiceWith(new Map([["user-1/mine", "Project: {{project}}"]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const result = await processor.processDirectiveAsync(
      "{{playbook:mine}}",
      mockExecutionContext({ project: "Moira" }),
    );

    expect(result).toBe("Project: Moira");
  });

  test("degrades to a visible placeholder and reports what was lost", async () => {
    const playbooks = playbookServiceWith(new Map());
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const { text, unresolvedPlaybooks } = await processor.processDirectiveAsyncWithReport(
      "Follow this: {{playbook:missing-standard}}",
      mockExecutionContext(),
    );

    expect(text).toBe("Follow this: [PLAYBOOK NOT AVAILABLE: missing-standard]");
    expect(unresolvedPlaybooks).toEqual([{ reference: "missing-standard", reason: "not-found" }]);
  });

  test("reports per presentation, so one step does not inherit another's loss", async () => {
    const playbooks = playbookServiceWith(new Map([["user-1/present", "Here."]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const lost = await processor.processDirectiveAsyncWithReport(
      "{{playbook:missing}}",
      mockExecutionContext(),
    );
    const fine = await processor.processDirectiveAsyncWithReport(
      "{{playbook:present}}",
      mockExecutionContext(),
    );

    expect(lost.unresolvedPlaybooks).toHaveLength(1);
    expect(fine.unresolvedPlaybooks).toHaveLength(0);
  });

  test("resolves a reference carried by a registry variable's default", async () => {
    // The third way a definition uses a playbook: not by naming it in the directive, but through a
    // declared variable whose authored default carries the reference. The directive names the
    // variable; the playbook text arrives with its value.
    const playbooks = playbookServiceWith(new Map([["user-1/standard", "Read the diff."]]));
    const processor = new GraphTemplateProcessor(undefined, playbooks);
    const context = mockExecutionContext({ review_rules: "{{playbook:standard}}" });
    (context as unknown as { _templateFragmentVars: Set<string> })._templateFragmentVars = new Set([
      "review_rules",
    ]);

    const result = await processor.processDirectiveAsync("Rules: {{review_rules}}", context);

    expect(result).toBe("Rules: Read the diff.");
  });

  test("keeps the step running when the registry itself fails", async () => {
    const playbooks = {
      resolveOwner: jest.fn(async () => "user-1"),
      get: jest.fn(async () => {
        throw new Error("registry unavailable");
      }),
    } as unknown as PlaybookService;
    const processor = new GraphTemplateProcessor(undefined, playbooks);

    const { text, unresolvedPlaybooks } = await processor.processDirectiveAsyncWithReport(
      "{{playbook:standard}}",
      mockExecutionContext(),
    );

    expect(text).toBe("[PLAYBOOK ERROR: standard]");
    expect(unresolvedPlaybooks).toEqual([{ reference: "standard", reason: "error" }]);
  });
});
