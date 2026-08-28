import { createHash } from "node:crypto";
import type { WorkflowProgress } from "@mcp-moira/workflow-engine";
import type { GraphNode, VariableRegistry } from "@mcp-moira/workflow-engine/types";

export type WorkflowSchemaNode = GraphNode;
export interface WorkflowSchemaInput {
  metadata: { name: string; version: string };
  nodes: GraphNode[];
  variableRegistry?: VariableRegistry;
  progress?: WorkflowProgress;
}

interface SchemaEdge {
  id: string;
  source: string;
  label: string;
  target: string;
  targetExists: boolean;
}

interface SchemaBlock {
  id: string;
  nodeIds: string[];
  cycleAnchor?: string;
}

interface Component {
  nodeIds: string[];
  cyclic: boolean;
  anchor: string;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function escapeNonJsonControls(serialized: string): string {
  return serialized.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function quotedText(value: string): string {
  return escapeNonJsonControls(JSON.stringify(value));
}

function inlineText(value: string): string {
  return quotedText(value).slice(1, -1);
}

function structuralToken(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : quotedText(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return escapeNonJsonControls(JSON.stringify(stableValue(value)));
}

function collectContextReferences(
  node: WorkflowSchemaNode,
  variableRegistry: Record<string, unknown> | undefined,
): string[] {
  const references = new Set<string>();
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (key === "contextPath") references.add(value);
      for (const match of value.matchAll(/(?<!\\)\{\{\s*([^{}]+?)\s*\}\}/g)) {
        references.add(`{{${match[1].trim()}}}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([nestedKey, nested]) =>
        walk(nested, nestedKey),
      );
    }
  };
  const record = node as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (["id", "type", "connections", "inputSchema"].includes(key)) continue;
    walk(value, key);
  }
  if (node.type === "materialize") {
    for (const file of node.files) {
      if (file.from) walk(variableRegistry?.[file.from]);
    }
  }
  return [...references].sort(compareStrings);
}

function directivePreview(node: WorkflowSchemaNode): string | undefined {
  const directive = (node as unknown as { directive?: unknown }).directive;
  if (typeof directive !== "string") return undefined;
  const firstParagraph = directive
    .trim()
    .split(/\n\s*\n|\n/)[0]
    ?.replace(/\s+/g, " ");
  if (!firstParagraph) return undefined;
  return firstParagraph.length > 200 ? `${firstParagraph.slice(0, 197)}...` : firstParagraph;
}

function buildComponents(
  nodeIds: string[],
  outgoing: Map<string, SchemaEdge[]>,
  order: Map<string, number>,
): Component[] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  const reverse = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]));
  const targetsByNode = new Map(
    nodeIds.map((nodeId) => [
      nodeId,
      (outgoing.get(nodeId) ?? []).filter((edge) => edge.targetExists).map((edge) => edge.target),
    ]),
  );
  for (const nodeId of nodeIds) {
    for (const target of targetsByNode.get(nodeId) ?? []) {
      reverse.get(target)!.push(nodeId);
    }
  }

  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ nodeId: string; nextEdge: number }> = [{ nodeId: start, nextEdge: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = targetsByNode.get(frame.nodeId) ?? [];
      if (frame.nextEdge < targets.length) {
        const target = targets[frame.nextEdge++];
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ nodeId: target, nextEdge: 0 });
        }
        continue;
      }
      finishOrder.push(frame.nodeId);
      stack.pop();
    }
  }

  const groups: string[][] = [];
  const assigned = new Set<string>();
  for (let index = finishOrder.length - 1; index >= 0; index--) {
    const start = finishOrder[index];
    if (assigned.has(start)) continue;
    const members: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const member = stack.pop()!;
      members.push(member);
      for (const predecessor of reverse.get(member) ?? []) {
        if (!assigned.has(predecessor)) {
          assigned.add(predecessor);
          stack.push(predecessor);
        }
      }
    }
    members.sort((left, right) => order.get(left)! - order.get(right)!);
    groups.push(members);
  }

  return groups
    .map((members) => ({
      nodeIds: members,
      cyclic:
        members.length > 1 ||
        (outgoing.get(members[0]) ?? []).some((edge) => edge.target === members[0]),
      anchor: members[0],
    }))
    .sort((left, right) => order.get(left.anchor)! - order.get(right.anchor)!);
}

function traversalOrder(
  nodeIds: string[],
  entries: string[],
  outgoing: Map<string, SchemaEdge[]>,
  order: Map<string, number>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visitFrom = (start: string): void => {
    const queue = [start];
    let cursor = 0;
    while (cursor < queue.length) {
      const nodeId = queue[cursor++];
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      result.push(nodeId);
      const targets = [...(outgoing.get(nodeId) ?? [])]
        .filter((edge) => edge.targetExists)
        .sort(
          (left, right) =>
            order.get(left.target)! - order.get(right.target)! ||
            compareStrings(left.label, right.label),
        )
        .map((edge) => edge.target);
      queue.push(...targets);
    }
  };
  entries.forEach(visitFrom);
  nodeIds.forEach(visitFrom);
  return result;
}

function reachableFrom(entries: string[], outgoing: Map<string, SchemaEdge[]>): Set<string> {
  const reachable = new Set<string>();
  const queue = [...entries];
  let cursor = 0;
  while (cursor < queue.length) {
    const nodeId = queue[cursor++];
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (edge.targetExists && !reachable.has(edge.target)) queue.push(edge.target);
    }
  }
  return reachable;
}

function buildBlocks(
  traversal: string[],
  incoming: Map<string, SchemaEdge[]>,
  outgoing: Map<string, SchemaEdge[]>,
  componentByNode: Map<string, Component>,
): SchemaBlock[] {
  const leaders = new Set<string>();
  for (const nodeId of traversal) {
    const predecessors = incoming.get(nodeId) ?? [];
    if (predecessors.length !== 1) leaders.add(nodeId);
    else if (
      (outgoing.get(predecessors[0].source) ?? []).filter((edge) => edge.targetExists).length !== 1
    )
      leaders.add(nodeId);
    const component = componentByNode.get(nodeId);
    if (component?.cyclic && component.anchor === nodeId) leaders.add(nodeId);
  }

  const assigned = new Set<string>();
  const blocks: SchemaBlock[] = [];
  for (const start of traversal) {
    if (assigned.has(start)) continue;
    const nodeIds = [start];
    assigned.add(start);
    let current = start;
    while (true) {
      const nextEdges = (outgoing.get(current) ?? []).filter((edge) => edge.targetExists);
      if (nextEdges.length !== 1) break;
      const target = nextEdges[0].target;
      if (assigned.has(target) || leaders.has(target) || (incoming.get(target) ?? []).length !== 1)
        break;
      const currentComponent = componentByNode.get(current);
      const targetComponent = componentByNode.get(target);
      if (
        (currentComponent?.cyclic || targetComponent?.cyclic) &&
        currentComponent !== targetComponent
      )
        break;
      nodeIds.push(target);
      assigned.add(target);
      current = target;
    }
    const component = componentByNode.get(start);
    blocks.push({
      id: `B${String(blocks.length + 1).padStart(3, "0")}`,
      nodeIds,
      cycleAnchor: component?.cyclic ? component.anchor : undefined,
    });
  }
  return blocks;
}

function renderOutputs(
  node: WorkflowSchemaNode,
  variableRegistry: Record<string, unknown> | undefined,
): string[] {
  const schema = (node as unknown as { inputSchema?: unknown }).inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const record = schema as Record<string, unknown>;
  const required = new Set(Array.isArray(record.required) ? record.required : []);
  const lines: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {};
  Object.keys(properties)
    .sort(compareStrings)
    .forEach((name) =>
      lines.push(
        `    OUTPUT local ${structuralToken(name)}${required.has(name) ? " required" : " optional"} ${stableJson(properties[name])}`,
      ),
    );
  const globals = Array.isArray(record.globalInputs)
    ? record.globalInputs.filter((name): name is string => typeof name === "string").sort()
    : [];
  globals.forEach((name) => {
    const declaration = variableRegistry?.[name];
    lines.push(
      `    OUTPUT global ${structuralToken(name)}${required.has(name) ? " required" : " optional"}${declaration === undefined ? " [UNDECLARED]" : ` ${stableJson(declaration)}`}`,
    );
  });
  return lines;
}

function renderDataFlow(
  node: WorkflowSchemaNode,
  variableRegistry: Record<string, unknown> | undefined,
): string[] {
  const lines = renderOutputs(node, variableRegistry);
  if (node.type === "start" && node.initialData !== undefined)
    lines.push(`    INITIAL_DATA ${stableJson(node.initialData)}`);
  if (node.type === "end" && node.finalOutput !== undefined)
    lines.push(`    OUTPUT final ${stableJson(node.finalOutput)}`);
  if (node.type === "subgraph") {
    lines.push(`    SUBGRAPH ${quotedText(node.graphId)}`);
    lines.push(`    INPUT_MAPPING ${stableJson(node.inputMapping)}`);
    lines.push(`    OUTPUT_MAPPING ${stableJson(node.outputMapping)}`);
  }
  if (
    (node.type === "read-note" || node.type === "upsert-note") &&
    node.outputVariable !== undefined
  )
    lines.push(`    OUTPUT context ${quotedText(node.outputVariable)}`);
  if (node.type === "write-note" && node.batchMode)
    lines.push(`    INPUT context ${quotedText(node.source)}`);
  if (node.type === "materialize") {
    const renderedSources = new Set<string>();
    for (const file of node.files) {
      if (!file.from || renderedSources.has(file.from)) continue;
      renderedSources.add(file.from);
      const declaration = variableRegistry?.[file.from];
      lines.push(
        `    INPUT registry ${structuralToken(file.from)}${declaration === undefined ? " [UNDECLARED]" : ` ${stableJson(declaration)}`}`,
      );
    }
  }
  return lines;
}

function appendReferenceList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`    ${label}: (none)`);
    return;
  }
  lines.push(`    ${label}:`);
  for (let offset = 0; offset < values.length; offset += 12) {
    lines.push(`      ${values.slice(offset, offset + 12).join(", ")}`);
  }
}

export function renderWorkflowSchema(workflow: WorkflowSchemaInput): string {
  if (!workflow || !Array.isArray(workflow.nodes))
    throw new Error("Workflow nodes must be an array");
  const seenIds = new Set<string>();
  const reportedDuplicateIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const node of workflow.nodes) {
    if (seenIds.has(node.id) && !reportedDuplicateIds.has(node.id)) {
      reportedDuplicateIds.add(node.id);
      duplicateIds.push(node.id);
    }
    seenIds.add(node.id);
  }
  if (duplicateIds.length > 0)
    throw new Error(
      `Duplicate node IDs prevent an unambiguous schema: ${duplicateIds.map(structuralToken).join(", ")}`,
    );

  const nodeIds = workflow.nodes.map((node) => node.id);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const order = new Map(nodeIds.map((id, index) => [id, index]));
  const edges: SchemaEdge[] = [];
  workflow.nodes.forEach((node) => {
    Object.entries(node.connections ?? {})
      .sort(([left], [right]) => compareStrings(left, right))
      .forEach(([label, target]) => {
        edges.push({
          id: `E${String(edges.length + 1).padStart(3, "0")}`,
          source: node.id,
          label,
          target,
          targetExists: nodeById.has(target),
        });
      });
  });
  const incoming = new Map(nodeIds.map((id) => [id, [] as SchemaEdge[]]));
  const outgoing = new Map(nodeIds.map((id) => [id, [] as SchemaEdge[]]));
  edges.forEach((edge) => {
    outgoing.get(edge.source)!.push(edge);
    if (edge.targetExists) incoming.get(edge.target)!.push(edge);
  });
  const startEntries = nodeIds.filter((id) => nodeById.get(id)!.type === "start");
  const teleportEntries = nodeIds.filter((id) => nodeById.get(id)!.type === "teleport");
  const disconnectedRoots = nodeIds.filter(
    (id) =>
      nodeById.get(id)!.type !== "start" &&
      nodeById.get(id)!.type !== "teleport" &&
      (incoming.get(id) ?? []).length === 0,
  );
  const terminals = nodeIds.filter((id) => (outgoing.get(id) ?? []).length === 0);
  const components = buildComponents(nodeIds, outgoing, order);
  const componentByNode = new Map<string, Component>();
  components.forEach((component) =>
    component.nodeIds.forEach((nodeId) => componentByNode.set(nodeId, component)),
  );
  const traversal = traversalOrder(
    nodeIds,
    [...startEntries, ...teleportEntries, ...disconnectedRoots],
    outgoing,
    order,
  );
  const blocks = buildBlocks(traversal, incoming, outgoing, componentByNode);
  const blockByNode = new Map<string, SchemaBlock>();
  blocks.forEach((block) => block.nodeIds.forEach((nodeId) => blockByNode.set(nodeId, block)));
  const blocksByCycle = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.cycleAnchor) continue;
    const cycleBlocks = blocksByCycle.get(block.cycleAnchor) ?? [];
    cycleBlocks.push(block.id);
    blocksByCycle.set(block.cycleAnchor, cycleBlocks);
  }
  const cycleEntries = new Map<string, string[]>();
  const cycleInternal = new Map<string, string[]>();
  const cycleExits = new Map<string, string[]>();
  const appendCycleEdge = (index: Map<string, string[]>, anchor: string, edgeId: string): void => {
    const edgeIds = index.get(anchor) ?? [];
    edgeIds.push(edgeId);
    index.set(anchor, edgeIds);
  };
  for (const edge of edges) {
    const sourceComponent = componentByNode.get(edge.source)!;
    const targetComponent = edge.targetExists ? componentByNode.get(edge.target) : undefined;
    if (targetComponent?.cyclic && targetComponent !== sourceComponent)
      appendCycleEdge(cycleEntries, targetComponent.anchor, edge.id);
    if (sourceComponent.cyclic && targetComponent === sourceComponent)
      appendCycleEdge(cycleInternal, sourceComponent.anchor, edge.id);
    if (sourceComponent.cyclic && targetComponent !== sourceComponent)
      appendCycleEdge(cycleExits, sourceComponent.anchor, edge.id);
  }
  const normallyReachable = reachableFrom(startEntries, outgoing);
  const teleportReachable = reachableFrom(teleportEntries, outgoing);
  const teleportOnly = nodeIds.filter(
    (id) => teleportReachable.has(id) && !normallyReachable.has(id),
  );
  const unreachableFromStart = nodeIds.filter((id) => !normallyReachable.has(id));
  const disconnected = nodeIds.filter(
    (id) => !normallyReachable.has(id) && !teleportReachable.has(id),
  );
  const checksum = createHash("sha256").update(stableJson(workflow)).digest("hex");
  const progressNodes = workflow.progress?.nodes ?? [];
  const progressEdges = progressNodes.filter((node) => node.connections?.default).length;
  const progressMappings = workflow.nodes.filter((node) => node.progressNodeId).length;
  const lines = [
    `WORKFLOW ${inlineText(workflow.metadata.name)} v${structuralToken(workflow.metadata.version)}`,
    `CHECKSUM ${checksum}`,
    `COUNTS nodes=${nodeIds.length} edges=${edges.length} blocks=${blocks.length} cycles=${components.filter((component) => component.cyclic).length} progress_nodes=${progressNodes.length} progress_edges=${progressEdges} progress_mappings=${progressMappings}`,
    `START_ENTRIES ${startEntries.length > 0 ? startEntries.map(structuralToken).join(", ") : "(none)"}`,
    `TELEPORT_ENTRIES ${teleportEntries.length > 0 ? teleportEntries.map(structuralToken).join(", ") : "(none)"}`,
    `DISCONNECTED_ROOTS ${disconnectedRoots.length > 0 ? disconnectedRoots.map(structuralToken).join(", ") : "(none)"}`,
    `TERMINALS ${terminals.length > 0 ? terminals.map(structuralToken).join(", ") : "(none)"}`,
    `DANGLING ${
      edges
        .filter((edge) => !edge.targetExists)
        .map((edge) => edge.id)
        .join(", ") || "(none)"
    }`,
    "",
    "PROGRESS",
  ];
  if (!workflow.progress) {
    lines.push("  (none)");
  } else {
    if (workflow.progress.title !== undefined)
      lines.push(`  TITLE ${quotedText(workflow.progress.title)}`);
    for (const progressNode of progressNodes) {
      const primaryNodeIds = workflow.nodes
        .filter((node) => node.progressNodeId === progressNode.id)
        .map((node) => structuralToken(node.id));
      lines.push(
        `  PROGRESS_NODE ${structuralToken(progressNode.id)} label=${quotedText(progressNode.label)} primary=${primaryNodeIds.join(", ") || "(none)"}`,
      );
      if (progressNode.connections?.default)
        lines.push(`    EDGE [default] -> ${structuralToken(progressNode.connections.default)}`);
    }
    lines.push(
      `  COVERAGE nodes=${progressNodes.length}/${progressNodes.length} edges=${progressEdges}/${progressEdges} mappings=${progressMappings}/${progressMappings}`,
    );
  }
  lines.push("", "BLOCKS");
  let renderedNodes = 0;
  let renderedEdges = 0;

  for (const block of blocks) {
    lines.push(
      "",
      `BLOCK ${block.id} ${block.nodeIds.map(structuralToken).join(" -> ")}${block.cycleAnchor ? ` [cycle ${structuralToken(block.cycleAnchor)}]` : ""}`,
    );
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId)!;
      const displayName = node.metadata?.displayName
        ? ` name=${quotedText(node.metadata.displayName)}`
        : "";
      lines.push(
        `  NODE ${structuralToken(node.id)} [${structuralToken(node.type)}]${displayName}`,
      );
      if (node.progressNodeId)
        lines.push(`    PROGRESS_NODE ${structuralToken(node.progressNodeId)}`);
      if (node.progressActiveLabel)
        lines.push(`    PROGRESS_ACTIVE_LABEL ${quotedText(node.progressActiveLabel)}`);
      renderedNodes++;
      const preview = directivePreview(node);
      if (preview) lines.push(`    DIRECTIVE ${quotedText(preview)}`);
      if (node.type === "condition") lines.push(`    CONDITION ${stableJson(node.condition)}`);
      if (node.type === "expression")
        (node.expressions ?? []).forEach((expression) =>
          lines.push(`    EXPRESSION ${quotedText(expression)}`),
        );
      lines.push(...renderDataFlow(node, workflow.variableRegistry));
      collectContextReferences(node, workflow.variableRegistry).forEach((reference) =>
        lines.push(`    CONTEXT ${inlineText(reference)}`),
      );
      for (const edge of outgoing.get(nodeId) ?? []) {
        const targetBlock = edge.targetExists ? blockByNode.get(edge.target)?.id : undefined;
        lines.push(
          `    EDGE ${edge.id} [${structuralToken(edge.label)}] -> ${structuralToken(edge.target)}${targetBlock && targetBlock !== block.id ? ` (${targetBlock})` : ""}${edge.targetExists ? "" : " [DANGLING]"}`,
        );
        renderedEdges++;
      }
    }
  }

  const cyclicComponents = components.filter((component) => component.cyclic);
  lines.push("", "CYCLES");
  if (cyclicComponents.length === 0) lines.push("  (none)");
  for (const component of cyclicComponents) {
    lines.push(`  CYCLE ${structuralToken(component.anchor)}`);
    appendReferenceList(lines, "blocks", blocksByCycle.get(component.anchor) ?? []);
    appendReferenceList(lines, "entries", cycleEntries.get(component.anchor) ?? []);
    appendReferenceList(lines, "internal", cycleInternal.get(component.anchor) ?? []);
    appendReferenceList(lines, "exits", cycleExits.get(component.anchor) ?? []);
  }

  lines.push(
    "",
    `UNREACHABLE_FROM_START ${unreachableFromStart.length > 0 ? unreachableFromStart.map(structuralToken).join(", ") : "(none)"}`,
    `TELEPORT_ONLY ${teleportOnly.length > 0 ? teleportOnly.map(structuralToken).join(", ") : "(none)"}`,
    `DISCONNECTED ${disconnected.length > 0 ? disconnected.map(structuralToken).join(", ") : "(none)"}`,
    `COVERAGE nodes=${renderedNodes}/${nodeIds.length} edges=${renderedEdges}/${edges.length}`,
  );
  return lines.join("\n");
}
