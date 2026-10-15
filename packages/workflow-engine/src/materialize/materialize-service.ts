import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { ExecutionContext, MaterializeNode, VariableRegistry } from "../types/index.js";
import {
  GraphTemplateProcessor,
  type UnresolvedPlaybookReference,
} from "../templates/graph-template-processor.js";
import { materializeTextFilesSchema, ValidationError } from "@mcp-moira/shared";

/**
 * Ceiling for a materialize set delivered into an agent's context instead of onto a filesystem.
 */
export const MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES = 256 * 1024;

export interface RenderedMaterializeFile {
  path: string;
  content: string;
}

function createTemplateContext(
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): ExecutionContext {
  return {
    ...executionContext,
    variables: { ...executionContext.variables },
    _templateFragmentVars: GraphTemplateProcessor.computeFragmentVars(registry),
  };
}

function normalizeSafeRelativePath(path: string, field: string): string {
  if (!path || path.includes("\0") || path.startsWith("/") || path.startsWith("\\")) {
    throw new ValidationError(`${field} must be a non-empty relative path`);
  }
  const slashPath = path.replaceAll("\\", "/");
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    throw new ValidationError(`${field} contains an unsafe path segment`);
  }
  const normalized = posix.normalize(slashPath);
  if (normalized !== slashPath) {
    throw new ValidationError(`${field} must be normalized`);
  }
  return normalized;
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function renderMaterializeBasePath(
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): Promise<string> {
  const processor = new GraphTemplateProcessor();
  const basePath = await processor.processDirectiveAsync(
    node.basePath,
    createTemplateContext(registry, executionContext),
  );
  if (!basePath || basePath.includes("\0")) {
    throw new ValidationError("Materialize basePath must be non-empty and contain no NUL");
  }
  return basePath;
}

export async function renderMaterializePaths(
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): Promise<string[]> {
  if (!Array.isArray(node.files) || node.files.length === 0) {
    throw new ValidationError("Materialize requires at least one file");
  }

  const processor = new GraphTemplateProcessor();
  const context = createTemplateContext(registry, executionContext);
  const renderedPaths: string[] = [];
  const paths = new Set<string>();

  for (const [index, file] of node.files.entries()) {
    normalizeSafeRelativePath(file.path, `files[${index}].path`);
    const hasFrom = typeof file.from === "string" && file.from.length > 0;
    const hasContent = Object.prototype.hasOwnProperty.call(file, "content");
    if (hasFrom === hasContent || (hasContent && file.content !== "")) {
      throw new ValidationError(
        `files[${index}] must declare exactly one of from or empty content`,
      );
    }

    const renderedPath = normalizeSafeRelativePath(
      await processor.processDirectiveAsync(file.path, context),
      `files[${index}].path after rendering`,
    );
    if (paths.has(renderedPath)) {
      throw new ValidationError(`Materialize path collision: '${renderedPath}'`);
    }
    paths.add(renderedPath);
    renderedPaths.push(renderedPath);
  }

  return renderedPaths;
}

/**
 * Render a materialize node's files, reporting any playbook reference that could not be resolved.
 *
 * A file's text can name a playbook, and there the usual placeholder never reaches the agent's
 * directive — the substitution happens inside a file it downloads. The caller therefore needs the
 * list to record the degradation where a person can see it.
 */
export async function renderMaterializeFilesWithReport(
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): Promise<{
  files: RenderedMaterializeFile[];
  unresolvedPlaybooks: UnresolvedPlaybookReference[];
}> {
  const processor = new GraphTemplateProcessor();
  const unresolvedPlaybooks: UnresolvedPlaybookReference[] = [];
  const files = await renderMaterializeFilesWith(
    processor,
    node,
    registry,
    executionContext,
    unresolvedPlaybooks,
  );
  return { files, unresolvedPlaybooks };
}

export async function renderMaterializeFiles(
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): Promise<RenderedMaterializeFile[]> {
  return renderMaterializeFilesWith(new GraphTemplateProcessor(), node, registry, executionContext);
}

async function renderMaterializeFilesWith(
  processor: GraphTemplateProcessor,
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
  unresolvedPlaybooks?: UnresolvedPlaybookReference[],
): Promise<RenderedMaterializeFile[]> {
  const context = createTemplateContext(registry, executionContext);
  const renderedPaths = await renderMaterializePaths(node, registry, executionContext);
  const rendered: RenderedMaterializeFile[] = [];

  for (const [index, file] of node.files.entries()) {
    const hasFrom = typeof file.from === "string" && file.from.length > 0;
    let source = "";
    if (hasFrom) {
      const currentDefault = registry?.[file.from!]?.default;
      if (typeof currentDefault !== "string") {
        throw new ValidationError(`Registry variable '${file.from}' must have a string default`);
      }
      source = currentDefault;
    }

    const renderedPath = renderedPaths[index];

    const report = await processor.processDirectiveAsyncWithReport(source, context);
    unresolvedPlaybooks?.push(...report.unresolvedPlaybooks);
    rendered.push({ path: renderedPath, content: report.text });
  }

  // Validate the same final text contract as the owner submission before an
  // archive grant can acquire an immutable original operation assignment.
  const validated = materializeTextFilesSchema.safeParse(rendered);
  if (!validated.success) {
    throw new ValidationError("Materialize files do not satisfy the owner source contract");
  }
  // renderMaterializePaths already performs the contract's slash normalization.
  return rendered;
}

/**
 * Refuse a set that is too large to hand to an agent directly.
 *
 * Refusal is the whole point: a truncated guide reads exactly like a complete one, so an agent
 * given a shortened file proceeds as if it had read all of it. Failing loudly keeps the agent's
 * knowledge of what it received accurate.
 */
export function assertMaterializeContextBudget(files: RenderedMaterializeFile[]): void {
  const totalBytes = files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (totalBytes > MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES) {
    throw new ValidationError(
      `Materialize set is ${totalBytes} bytes, which exceeds the ` +
        `${MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES} byte limit for delivery into agent context. ` +
        `Download the archive with the presented command instead.`,
    );
  }
}
