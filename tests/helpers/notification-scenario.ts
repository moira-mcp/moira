/**
 * Runs a bundled flow the way the server runs it — `UniversalGraphExecutor` over a repository that
 * saves every execution — and captures every notification a person would receive, on the same
 * delivery path (the active communication registry). Answers come from per-node mock inputs.
 *
 * Unlike `scenario-runner.ts`, which drives the stateless engine with an unsaved context, this
 * harness has a real run: a task note, a persisted route and the live run a notification reads,
 * so a scenario can assert the delivered text itself.
 */

import {
  InMemoryRepository,
  MaterializeHandler,
  registerActiveCommunicationChannel,
  unregisterActiveCommunicationChannel,
  type PortableCommunicationMessage,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { migrateWorkflowGraph } from "@mcp-moira/workflow-engine/migration";
import { UniversalGraphExecutor } from "../../packages/workflow-engine/src/core/universal-graph-executor.js";

export const NOTIFICATION_TEST_USER = "notification-scenario-user";

export interface NotificationMockContext {
  variables: Record<string, unknown>;
  executionId: string;
  /** 1 on the first visit of the node. */
  visit: number;
}

/** A node's answer: always the same, one per visit in order, or computed from the run. */
export type NotificationMockInput =
  | Record<string, unknown>
  | Record<string, unknown>[]
  | ((context: NotificationMockContext) => Record<string, unknown>);

export interface NotificationScenario {
  mockInputs: Record<string, NotificationMockInput>;
  /** Instead of answering the given visit of a node, jump to a teleport node (once). */
  teleportAt?: { node: string; visit?: number; teleportTo: string };
  /** Note given at start; flows set their own at their first step when absent. */
  note?: string;
  maxSteps?: number;
}

export interface DeliveredNotification {
  /** The notification node that sent it. */
  nodeId: string;
  text: string;
  format?: string;
}

/** A pause the run stood at, as stored before it was answered. */
export interface ScenarioPause {
  nodeId: string;
  /** 1 on the first visit of the node. */
  visit: number;
  /** The stored «waiting for you» mark of a `humanGate` step, decided as the run arrived. */
  gateWaiting: boolean;
}

export interface NotificationScenarioResult {
  executionId: string;
  status: string;
  /** Every node the run passed, in order. */
  route: string[];
  /** Every pause the run was answered at, in order. */
  pauses: ScenarioPause[];
  notifications: DeliveredNotification[];
  variables: Record<string, unknown>;
}

function answer(
  mock: NotificationMockInput | undefined,
  context: NotificationMockContext,
): Record<string, unknown> | undefined {
  if (mock === undefined) return undefined;
  if (typeof mock === "function") return mock(context);
  if (Array.isArray(mock)) return mock[Math.min(context.visit, mock.length) - 1];
  return mock;
}

/** Run `workflow` to its end, answering its pauses from `scenario`. */
export async function runNotificationScenario(
  workflow: WorkflowGraph,
  scenario: NotificationScenario,
): Promise<NotificationScenarioResult> {
  const graph = migrateWorkflowGraph(workflow).graph;
  const repository = new InMemoryRepository();
  await repository.saveWorkflow(graph, NOTIFICATION_TEST_USER);
  const executor = new UniversalGraphExecutor(repository);
  // Materialize grants live in the token store; a scenario only needs the node to pass.
  const engine = (
    executor as unknown as { graphEngine: { nodeHandlers: Map<string, MaterializeHandler> } }
  ).graphEngine;
  engine.nodeHandlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "notification-scenario-token" },
      () => "https://moira.example",
    ),
  );
  const types = new Map(graph.nodes.map((node) => [node.id, node.type]));

  const delivered: PortableCommunicationMessage[] = [];
  const channelId = `test.notification-scenario.${Math.random().toString(36).slice(2)}`;
  registerActiveCommunicationChannel({
    id: channelId,
    provider: channelId,
    capabilities: { text: true, image: true, document: true, trusted: false },
    metadata: { title: "Capturing", origin: "builtin", settingKeys: [] },
    isConfigured: async () => true,
    deliver: async (message) => {
      delivered.push(message);
    },
  });

  try {
    const executionId = await executor.startWorkflow(
      graph,
      undefined,
      NOTIFICATION_TEST_USER,
      scenario.note,
    );
    const visits = new Map<string, number>();
    const pauses: ScenarioPause[] = [];
    let teleported = false;
    const maxSteps = scenario.maxSteps ?? 200;
    for (let step = 0; step < maxSteps; step++) {
      const execution = await repository.getExecution(executionId);
      if (!execution) throw new Error("execution vanished");
      if (execution.status === "completed") break;
      const nodeId = execution.currentNodeId!;
      const visit = (visits.get(nodeId) ?? 0) + 1;
      visits.set(nodeId, visit);
      pauses.push({ nodeId, visit, gateWaiting: execution.gateWaiting === true });
      const jump = scenario.teleportAt;
      if (jump && !teleported && nodeId === jump.node && visit === (jump.visit ?? 1)) {
        teleported = true;
        await executor.executeStep(executionId, undefined, jump.teleportTo);
        continue;
      }
      const input = answer(scenario.mockInputs[nodeId], {
        variables: execution.globalContext.variables,
        executionId,
        visit,
      });
      const response = await executor.executeStep(executionId, input);
      const after = await repository.getExecution(executionId);
      if (
        after?.status !== "completed" &&
        after?.currentNodeId === nodeId &&
        types.get(nodeId) !== "materialize" &&
        /VALIDATION ERROR/u.test(response)
      ) {
        throw new Error(`The answer for ${nodeId} (visit ${visit}) was rejected:\n${response}`);
      }
    }
    const execution = (await repository.getExecution(executionId))!;
    if (execution.status !== "completed") {
      throw new Error(
        `The run did not finish within ${maxSteps} steps; it is at ${execution.currentNodeId}`,
      );
    }
    const route = (execution.visits ?? []).filter((visit) => !visit.adjusted).map((v) => v.nodeId);
    const senders = route.filter((nodeId) => types.get(nodeId) === "user-notification");
    if (senders.length !== delivered.length) {
      throw new Error(
        `${senders.length} notification nodes ran but ${delivered.length} messages were delivered`,
      );
    }
    return {
      executionId,
      status: execution.status,
      route,
      pauses,
      notifications: delivered.map((message, index) => ({
        nodeId: senders[index],
        text: message.text,
        format: message.format,
      })),
      variables: execution.globalContext.variables,
    };
  } finally {
    unregisterActiveCommunicationChannel(channelId);
  }
}

/** Every string enum value declared in the registry or a node's input schema. */
function enumValues(workflow: WorkflowGraph): string[] {
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum)) {
      for (const entry of record.enum) if (typeof entry === "string") values.add(entry);
    }
    Object.values(record).forEach(walk);
  };
  walk(workflow.variableRegistry ?? {});
  for (const node of workflow.nodes) walk((node as { inputSchema?: unknown }).inputSchema);
  return [...values];
}

/**
 * Internal values a person should never read in a notification: path syntax (relative with a file
 * extension, absolute, `./`/`~/`, or any path of three or more segments with a letter in it),
 * template syntax, the undefined placeholder, identifier-like node ids, registry keys and enum
 * values (those joined with `-` or `_`, matched as whole tokens), and an 8-hex run-id prefix.
 * Plain-word ids, keys and enum values (`end`, `tasks`, `complete`) cannot be told from prose and
 * are not scanned — and the validator's notification content warning does not flag them either
 * (it flags paths, raw node outputs and bare counters). A flow whose message interpolates an
 * enum-valued variable must assert in its own scenario that the delivered text words it. Returns
 * what it found.
 */
export function internalValues(text: string, workflow: WorkflowGraph): string[] {
  const found: string[] = [];
  const withoutUrls = text.replace(/https?:\/\/\S+/gu, " ");
  const pathForms = [
    /(?:^|[\s(`'"])((?:\.{1,2}\/|~\/|\/?[\w-]+\/[\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b)[\w./-]*)/u,
    /(?:^|[\s(`'"])(\/[\w.-]+\/[\w./-]*[A-Za-z][\w./-]*)/u,
    /(?:^|[\s(`'"])((?=[\w.-]*[A-Za-z])[\w.-]+\/[\w.-]+\/[\w./-]*)/u,
  ];
  for (const form of pathForms) {
    const path = form.exec(withoutUrls);
    if (path) {
      found.push(`path ${path[1]}`);
      break;
    }
  }
  if (text.includes("{{")) found.push("template syntax");
  if (text.includes("[[UNDEFINED_VARIABLE]]")) found.push("undefined placeholder");
  const identifiers = [
    ...workflow.nodes.map((node) => node.id),
    ...Object.keys(workflow.variableRegistry ?? {}),
    ...enumValues(workflow),
  ].filter((name) => /^[\w-]+$/u.test(name) && /[-_]/u.test(name));
  for (const name of new Set(identifiers)) {
    const pattern = new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "u");
    if (pattern.test(withoutUrls)) found.push(`identifier ${name}`);
  }
  if (/(?<![\w/-])[0-9a-f]{8}(?![\w-])/u.test(withoutUrls)) found.push("run id prefix");
  return found;
}
