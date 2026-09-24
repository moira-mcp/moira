/**
 * The learning examples run end to end through the MCP tools an agent uses — `start` and `step`
 * against the bundled catalog — in both languages: each step hands the agent the flow's own
 * instruction text, in that flow's language, and the answer the agent gives picks the branch.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

function requiredId(response: string, label: "Start attempt" | "Process" | "Step attempt"): string {
  const id = response.match(new RegExp(`${label} ID:\\s*([a-f0-9-]+)`, "i"))?.[1];
  if (!id) throw new Error(`${label} ID missing from MCP response: ${response}`);
  return id;
}

/** Run a flow with the given answers, returning the directive text shown before each answer. */
async function run(
  client: Client,
  workflowId: string,
  answers: Array<Record<string, string>>,
): Promise<{ shown: string[]; last: string }> {
  const preparation = await callMCPTool<string>(client, "start", {
    action: "prepare",
    parentExecutionId: "none",
    workflowId,
  });
  let response = await callMCPTool<string>(client, "start", {
    action: "execute",
    startAttemptId: requiredId(preparation, "Start attempt"),
  });
  const processId = requiredId(response, "Process");
  const shown: string[] = [];
  for (const input of answers) {
    shown.push(response);
    response = await callMCPTool<string>(client, "step", {
      processId,
      attemptId: requiredId(response, "Step attempt"),
      input,
    });
  }
  return { shown, last: response };
}

describe("learning examples over MCP", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ client, cleanup } = await createAuthenticatedMCPClient());
  });

  afterAll(async () => {
    await cleanup();
  });

  test("Example 1 runs its four steps in order and completes", async () => {
    const { shown, last } = await run(client, "moira/example-simple-steps", [
      { task: "Rename the file" },
      { result: "Renamed it" },
      { check: "Listed the folder" },
      { report: "Renamed the file and checked the folder" },
    ]);
    expect(shown[0]).toContain("restate the task in one sentence");
    expect(shown[3]).toContain("what you did and how you checked it");
    expect(last).toContain("Workflow completed");
  });

  test("Example 2 in Russian takes the 'no' branch and says what is missing", async () => {
    const { shown, last } = await run(client, "moira/example-one-choice-ru", [
      { result: "Написал половину заметки" },
      { matches: "no" },
      { report: "Для второй половины нет данных" },
    ]);
    expect(shown[1]).toContain("Проверьте результат по запросу");
    expect(shown[2]).toContain("чего не хватает и почему");
    expect(last).toContain("Workflow completed");
  });

  test("Example 3 sends a bug down its own path", async () => {
    const { shown, last } = await run(client, "moira/example-several-paths", [
      { kind: "bug" },
      { fix: "Fixed the typo and reran the script" },
    ]);
    expect(shown[1]).toContain("Reproduce the bug");
    expect(last).toContain("Workflow completed");
  });
});
