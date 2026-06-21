/**
 * Upsert Note Handler - AUTOMATIC node for update-or-create operations
 *
 * Finds note by search criteria. If found, updates it. If not found, creates new.
 * All parameters support template expressions {{variable}}.
 * Executes automatically without pausing for agent input.
 */

import { GraphNode, ExecutionContext, isUpsertNoteNode, UpsertNoteNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError, getNoteService, NoteService } from "@mcp-moira/shared";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";

interface UpsertResult {
  key: string;
  version: number;
  created: boolean;
}

export class UpsertNoteHandler implements INodeHandler {
  private logger = createLogger({ component: "UpsertNoteHandler" });
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
    return "upsert-note";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    _messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isUpsertNoteNode(node)) {
      throw new InternalError("UpsertNoteHandler can only execute upsert-note nodes", {
        nodeType: node.type,
      });
    }

    const upsertNode = node as UpsertNoteNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing upsert-note node", {
      nodeId: upsertNode.id,
      executionId: context.executionId,
      hasSearch: !!upsertNode.search,
    });

    try {
      // Process template expressions (auto-serialize objects for value)
      const value = this.resolveValueForStorage(upsertNode.value, context);
      const keyTemplate = this.processTemplate(upsertNode.keyTemplate, context);
      const tags = upsertNode.tags?.map((tag) => this.processTemplate(tag, context));

      // Build search filter
      const searchFilter: { tag?: string; keySearch?: string } = {};
      if (upsertNode.search?.tag) {
        searchFilter.tag = this.processTemplate(upsertNode.search.tag, context);
      }
      if (upsertNode.search?.keyPattern) {
        searchFilter.keySearch = this.processTemplate(upsertNode.search.keyPattern, context);
      }

      // Search for existing note
      let existingKey: string | null = null;

      if (searchFilter.tag || searchFilter.keySearch) {
        const searchResult = await this.noteService.list(context.userId, searchFilter);

        if (searchResult.notes.length > 0) {
          // Found existing note - use the first match
          existingKey = searchResult.notes[0].key;
          this.logger.debug("Found existing note for upsert", {
            nodeId: upsertNode.id,
            key: existingKey,
            matchCount: searchResult.notes.length,
          });
        }
      }

      // Determine final key
      const finalKey = existingKey || keyTemplate;
      const created = existingKey === null;

      // Save note (creates or updates)
      const result = await this.noteService.save(context.userId, {
        key: finalKey,
        value,
        tags,
      });

      const upsertResult: UpsertResult = {
        key: finalKey,
        version: result.version,
        created,
      };

      const executionTime = timer.elapsed();

      this.logger.info("Upsert-note node completed", {
        nodeId: upsertNode.id,
        executionTime,
        key: finalKey,
        created,
        version: result.version,
      });

      // Build output data
      const outputData: Record<string, unknown> = {
        upsertNoteResult: upsertResult,
      };

      // If outputVariable is specified, also store result there
      if (upsertNode.outputVariable) {
        outputData[upsertNode.outputVariable] = upsertResult;
      }

      // Return continue with result
      return NodeResultBuilder.continue(upsertNode.id, "default", outputData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error("Upsert-note node failed", {
        nodeId: upsertNode.id,
        error: errorMessage,
      });

      // Check if error connection exists
      if (upsertNode.connections.error) {
        return NodeResultBuilder.continue(upsertNode.id, "error", {
          upsertNoteError: errorMessage,
        });
      }

      // No error connection - throw to boundary
      throw error;
    }
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isUpsertNoteNode(node);
  }

  /**
   * Resolve a template value for note storage with auto-serialization.
   *
   * When the template is a pure variable reference (e.g., "{{gather-metrics.metrics}}"),
   * resolves the raw context value and serializes objects/arrays with JSON.stringify.
   */
  private resolveValueForStorage(template: string, context: ExecutionContext): string {
    const rawValue = this.resolveRawValue(template, context);

    if (rawValue !== undefined) {
      return this.serializeForStorage(rawValue);
    }

    return this.processTemplate(template, context);
  }

  /**
   * Serialize a raw value for note storage.
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
   */
  private resolveRawValue(template: string, context: ExecutionContext): unknown | undefined {
    const trimmed = template.trim();

    const pureTemplateMatch = trimmed.match(/^\{\{([a-zA-Z_][a-zA-Z0-9_\-.[\]]*)\}\}$/);
    if (!pureTemplateMatch) {
      return undefined;
    }

    const path = pureTemplateMatch[1];
    return this.getContextValue(context, path);
  }

  /**
   * Get value from context by path (supports dots and bracket notation)
   */
  private getContextValue(context: ExecutionContext, path: string): unknown {
    if (!path.includes(".") && !path.includes("[")) {
      return context.variables[path];
    }

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
   * Parse path into segments
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

  /**
   * Process template expression in string
   */
  private processTemplate(template: string, context: ExecutionContext): string {
    return this.templateProcessor.processDirective(template, context);
  }
}
