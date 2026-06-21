/**
 * Read Note Handler - AUTOMATIC node for reading notes into context
 *
 * Reads notes matching filter criteria and stores them in context variable.
 * All filter parameters support template expressions {{variable}}.
 * Executes automatically without pausing for agent input.
 */

import { GraphNode, ExecutionContext, isReadNoteNode, ReadNoteNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createLogger, InternalError, getNoteService, NoteService } from "@mcp-moira/shared";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";

export class ReadNoteHandler implements INodeHandler {
  private logger = createLogger({ component: "ReadNoteHandler" });
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
    return "read-note";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    _messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isReadNoteNode(node)) {
      throw new InternalError("ReadNoteHandler can only execute read-note nodes", {
        nodeType: node.type,
      });
    }

    const readNode = node as ReadNoteNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing read-note node", {
      nodeId: readNode.id,
      executionId: context.executionId,
      outputVariable: readNode.outputVariable,
      hasFilter: !!readNode.filter,
    });

    try {
      // Process template expressions in filter parameters
      const filter: { tag?: string; keySearch?: string } = {};

      if (readNode.filter?.tag) {
        filter.tag = this.processTemplate(readNode.filter.tag, context);
      }

      if (readNode.filter?.keyPattern) {
        // keyPattern is used as keySearch with prefix matching
        filter.keySearch = this.processTemplate(readNode.filter.keyPattern, context);
      }

      if (readNode.filter?.keySearch) {
        filter.keySearch = this.processTemplate(readNode.filter.keySearch, context);
      }

      // Get notes from NoteService
      const result = await this.noteService.list(context.userId, {
        tag: filter.tag,
        keySearch: filter.keySearch,
      });

      this.logger.info("Notes retrieved", {
        nodeId: readNode.id,
        count: result.notes.length,
        total: result.total,
      });

      // Determine output format
      let output: unknown;
      if (readNode.singleMode && result.notes.length === 1) {
        // Single mode: output as object
        const note = await this.noteService.get(context.userId, result.notes[0].key);
        output = {
          key: note.key,
          value: note.value,
          tags: note.tags,
          version: note.version,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        };
      } else {
        // Array mode: output as array of notes
        const notes = await Promise.all(
          result.notes.map(async (summary) => {
            const note = await this.noteService.get(context.userId, summary.key);
            return {
              key: note.key,
              value: note.value,
              tags: note.tags,
              version: note.version,
              createdAt: note.createdAt,
              updatedAt: note.updatedAt,
            };
          }),
        );
        output = notes;
      }

      const executionTime = timer.elapsed();

      this.logger.info("Read-note node completed", {
        nodeId: readNode.id,
        executionTime,
        outputVariable: readNode.outputVariable,
        resultCount: Array.isArray(output) ? output.length : 1,
      });

      // Return continue with output variable data
      return NodeResultBuilder.continue(readNode.id, "default", {
        [readNode.outputVariable]: output,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error("Read-note node failed", {
        nodeId: readNode.id,
        error: errorMessage,
      });

      // Check if error connection exists
      if (readNode.connections.error) {
        return NodeResultBuilder.continue(readNode.id, "error", {
          readNoteError: errorMessage,
        });
      }

      // No error connection - throw to boundary
      throw error;
    }
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isReadNoteNode(node);
  }

  /**
   * Process template expression in string
   */
  private processTemplate(template: string, context: ExecutionContext): string {
    return this.templateProcessor.processDirective(template, context);
  }
}
