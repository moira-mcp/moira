/**
 * Write Note Handler - AUTOMATIC node for writing notes from context
 *
 * Writes data to notes from context variables.
 * Supports single mode (one note) and batch mode (array of notes).
 * All parameters support template expressions {{variable}}.
 * Executes automatically without pausing for agent input.
 */

import { GraphNode, ExecutionContext, isWriteNoteNode, WriteNoteNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import {
  createLogger,
  InternalError,
  ValidationError,
  getNoteService,
  NoteService,
} from "@mcp-moira/shared";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";

interface BatchNoteItem {
  key: string;
  value: string;
  tags?: string[];
}

interface WriteResult {
  key: string;
  version: number;
  created: boolean;
}

export class WriteNoteHandler implements INodeHandler {
  private logger = createLogger({ component: "WriteNoteHandler" });
  private templateProcessor: GraphTemplateProcessor;
  private _noteService: NoteService | null = null;

  /**
   * @param noteService - Optional NoteService for testing. If not provided, will use singleton.
   */
  constructor(noteService?: NoteService) {
    this.templateProcessor = new GraphTemplateProcessor();
    this._noteService = noteService || null;
  }

  /**
   * Get NoteService lazily to support testing with mocks
   */
  private get noteService(): NoteService {
    if (!this._noteService) {
      this._noteService = getNoteService();
    }
    return this._noteService;
  }

  getNodeType(): string {
    return "write-note";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    _messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isWriteNoteNode(node)) {
      throw new InternalError("WriteNoteHandler can only execute write-note nodes", {
        nodeType: node.type,
      });
    }

    const writeNode = node as WriteNoteNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing write-note node", {
      nodeId: writeNode.id,
      executionId: context.executionId,
      batchMode: writeNode.batchMode,
    });

    try {
      let results: WriteResult[];

      if (writeNode.batchMode) {
        results = await this.executeBatchMode(writeNode, context);
      } else {
        results = await this.executeSingleMode(writeNode, context);
      }

      const executionTime = timer.elapsed();

      this.logger.info("Write-note node completed", {
        nodeId: writeNode.id,
        executionTime,
        notesWritten: results.length,
      });

      // Return continue with results
      return NodeResultBuilder.continue(writeNode.id, "default", {
        writeNoteResults: results,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error("Write-note node failed", {
        nodeId: writeNode.id,
        error: errorMessage,
      });

      // Check if error connection exists
      if (writeNode.connections.error) {
        return NodeResultBuilder.continue(writeNode.id, "error", {
          writeNoteError: errorMessage,
        });
      }

      // No error connection - throw to boundary
      throw error;
    }
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isWriteNoteNode(node);
  }

  /**
   * Execute single mode - write one note
   */
  private async executeSingleMode(
    node: WriteNoteNode,
    context: ExecutionContext,
  ): Promise<WriteResult[]> {
    if (!node.key) {
      throw new ValidationError("Write-note node in single mode requires key", {
        nodeId: node.id,
      });
    }

    // Process templates
    const key = this.processTemplate(node.key, context);
    const value = this.resolveValueForStorage(node.source, context);
    const tags = node.tags?.map((tag) => this.processTemplate(tag, context));

    // Check if note exists
    const exists = await this.noteService.exists(context.userId, key);

    // Save note
    const result = await this.noteService.save(context.userId, {
      key,
      value,
      tags,
    });

    return [
      {
        key,
        version: result.version,
        created: !exists,
      },
    ];
  }

  /**
   * Execute batch mode - write multiple notes from array
   */
  private async executeBatchMode(
    node: WriteNoteNode,
    context: ExecutionContext,
  ): Promise<WriteResult[]> {
    // Get source variable from context
    const sourcePath = node.source;
    const sourceData = this.getContextValue(context, sourcePath);

    if (!Array.isArray(sourceData)) {
      throw new ValidationError("Write-note batch mode requires source to be an array", {
        nodeId: node.id,
        sourcePath,
        actualType: typeof sourceData,
      });
    }

    const results: WriteResult[] = [];

    for (const item of sourceData as BatchNoteItem[]) {
      if (!item.key || item.value === undefined) {
        this.logger.warn("Skipping batch item without key or value", {
          nodeId: node.id,
          item,
        });
        continue;
      }

      // Process templates in item values
      const key = this.processTemplate(item.key, context);
      const value = this.processTemplate(String(item.value), context);

      // Use item tags if provided, otherwise use node default tags
      let tags: string[] | undefined;
      if (item.tags) {
        tags = item.tags.map((tag) => this.processTemplate(tag, context));
      } else if (node.tags) {
        tags = node.tags.map((tag) => this.processTemplate(tag, context));
      }

      // Check if note exists
      const exists = await this.noteService.exists(context.userId, key);

      // Save note
      const result = await this.noteService.save(context.userId, {
        key,
        value,
        tags,
      });

      results.push({
        key,
        version: result.version,
        created: !exists,
      });
    }

    return results;
  }

  /**
   * Resolve a template value for note storage with auto-serialization.
   *
   * When the template is a pure variable reference (e.g., "{{gather-metrics.metrics}}"),
   * resolves the raw context value and serializes objects/arrays with JSON.stringify.
   * This prevents [object Object] or invalid formats from safeSerialize.
   *
   * For mixed templates (text + variables), falls back to processTemplate.
   */
  private resolveValueForStorage(template: string, context: ExecutionContext): string {
    const rawValue = this.resolveRawValue(template, context);

    if (rawValue !== undefined) {
      return this.serializeForStorage(rawValue);
    }

    // Mixed template or unresolvable — use standard template processing
    return this.processTemplate(template, context);
  }

  /**
   * Serialize a raw value for note storage.
   * Objects/arrays → JSON.stringify, primitives → String, strings → as-is.
   */
  private serializeForStorage(value: unknown): string {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Try to resolve a pure template reference to its raw context value.
   * Returns undefined if the template is not a pure single-variable reference.
   *
   * Handles:
   *  - "{{variableName}}" → context.variables[variableName]
   *  - "{{node-id.field}}" → context.variables[node-id].field (dot-path)
   *
   * Does NOT handle mixed templates like "prefix {{var}} suffix".
   */
  private resolveRawValue(template: string, context: ExecutionContext): unknown | undefined {
    const trimmed = template.trim();

    // Must be exactly one template expression with no surrounding text
    const pureTemplateMatch = trimmed.match(/^\{\{([a-zA-Z_][a-zA-Z0-9_\-.[\]]*)\}\}$/);
    if (!pureTemplateMatch) {
      return undefined;
    }

    const path = pureTemplateMatch[1];
    return this.getContextValue(context, path);
  }

  /**
   * Process template expression in string
   */
  private processTemplate(template: string, context: ExecutionContext): string {
    return this.templateProcessor.processDirective(template, context);
  }

  /**
   * Get value from context by path (supports dots and bracket notation)
   */
  private getContextValue(context: ExecutionContext, path: string): unknown {
    if (!path.includes(".") && !path.includes("[")) {
      return context.variables[path];
    }

    // Parse path segments supporting both dot and bracket notation
    const segments = this.parsePath(path);
    let current: unknown = context.variables;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof segment === "number") {
        if (Array.isArray(current)) {
          current = current[segment];
        } else {
          return undefined;
        }
      } else {
        current = (current as Record<string, unknown>)[segment];
      }
    }

    return current;
  }

  /**
   * Parse path into segments: "gather-metrics.field" → ["gather-metrics", "field"]
   * Also handles bracket notation: "data[0].field" → ["data", 0, "field"]
   */
  private parsePath(path: string): (string | number)[] {
    const segments: (string | number)[] = [];
    let current = "";
    let i = 0;

    while (i < path.length) {
      const char = path[i];
      if (char === ".") {
        if (current) {
          segments.push(current);
          current = "";
        }
      } else if (char === "[") {
        if (current) {
          segments.push(current);
          current = "";
        }
        i++;
        let indexStr = "";
        while (i < path.length && path[i] !== "]") {
          indexStr += path[i];
          i++;
        }
        const index = parseInt(indexStr, 10);
        if (!isNaN(index)) {
          segments.push(index);
        }
      } else {
        current += char;
      }
      i++;
    }

    if (current) {
      segments.push(current);
    }

    return segments;
  }
}
