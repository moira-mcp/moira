import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { pack } from "tar-stream";
import type { ExecutionContext, MaterializeNode, VariableRegistry } from "../types/index.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { ValidationError } from "@mcp-moira/shared";

export const MATERIALIZE_MAX_FILES = 100;
export const MATERIALIZE_MAX_FILE_BYTES = 1024 * 1024;
export const MATERIALIZE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface RenderedMaterializeFile {
  path: string;
  content: Buffer;
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
  if (node.files.length > MATERIALIZE_MAX_FILES) {
    throw new ValidationError(`Materialize supports at most ${MATERIALIZE_MAX_FILES} files`);
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

export async function renderMaterializeFiles(
  node: MaterializeNode,
  registry: VariableRegistry | undefined,
  executionContext: ExecutionContext,
): Promise<RenderedMaterializeFile[]> {
  const processor = new GraphTemplateProcessor();
  const context = createTemplateContext(registry, executionContext);
  const renderedPaths = await renderMaterializePaths(node, registry, executionContext);
  const rendered: RenderedMaterializeFile[] = [];
  let totalBytes = 0;

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

    const renderedContent = await processor.processDirectiveAsync(source, context);
    const content = Buffer.from(renderedContent, "utf8");
    if (content.byteLength > MATERIALIZE_MAX_FILE_BYTES) {
      throw new ValidationError(
        `Materialize file '${renderedPath}' exceeds ${MATERIALIZE_MAX_FILE_BYTES} bytes`,
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > MATERIALIZE_MAX_TOTAL_BYTES) {
      throw new ValidationError(
        `Materialize archive exceeds ${MATERIALIZE_MAX_TOTAL_BYTES} uncompressed bytes`,
      );
    }
    rendered.push({ path: renderedPath, content });
  }

  return rendered;
}

export async function createMaterializeTar(files: RenderedMaterializeFile[]): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      return;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      return;
    }
    archive.destroy(new TypeError("Materialize tar stream emitted a non-binary chunk"));
  });
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.once("end", () => resolve(Buffer.concat(chunks)));
    archive.once("error", reject);
  });
  for (const file of files) {
    archive.entry({ name: file.path, size: file.content.byteLength, mode: 0o644 }, file.content);
  }
  archive.finalize();
  return completed;
}
