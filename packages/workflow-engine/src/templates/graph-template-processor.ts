/**
 * Graph Template Processor - Template processing for node directives
 * Supports {{variable}} syntax in agent-directive nodes
 * Supports {{note:KEY}} syntax for note references (async only)
 *
 * ESCAPE SYNTAX:
 * Use \{{ to output literal {{ without template processing.
 * Example: "Use \{{executionId}} in your template" → "Use {{executionId}} in your template"
 * This is useful for documentation strings that contain template syntax examples.
 */

import type { ExecutionContext } from "../types/base-types.js";
import { runPageUrl } from "../utils/notification-text.js";
import { GraphTemplateProcessor as TemplateCore } from "./graph-template-core.js";
import { createLogger } from "@mcp-moira/shared/logging/logger";
import { getNoteService, getPlaybookService } from "@mcp-moira/shared/services";
import { collectPlaybookReferences } from "@mcp-moira/shared/services/playbook-references";
import { NoteNotFoundError } from "@mcp-moira/shared/errors";
import type { NoteService } from "@mcp-moira/shared/services/note-service";
import type { PlaybookService } from "@mcp-moira/shared/services/playbook-service";

export interface GraphTemplateContext {
  variables: Record<string, unknown>;
  nodeStates: Record<string, unknown>;
  executionId: string;
  workflowId: string;
  currentNodeId?: string;
}

/**
 * One unresolved playbook reference, recorded so a run can say what it lost.
 *
 * A reference that cannot be resolved does not stop the step — the agent gets a placeholder — but
 * the run must not degrade silently, and for a reference inside a materialized file the placeholder
 * never reaches the directive at all.
 */
export interface UnresolvedPlaybookReference {
  reference: string;
  reason: "not-found" | "error";
}

export class GraphTemplateProcessor extends TemplateCore {
  private _noteService: NoteService | null;
  private _playbookService: PlaybookService | null;

  constructor(
    noteService?: NoteService,
    playbookService?: PlaybookService,
    valueEncoder?: (text: string) => string,
  ) {
    super(valueEncoder, runPageUrl, createLogger({ component: "GraphTemplateProcessor" }));
    this._noteService = noteService ?? null;
    this._playbookService = playbookService ?? null;
  }

  static override systemValue(
    name: string,
    context: ExecutionContext,
    includeUser = false,
  ): string | undefined {
    return TemplateCore.systemValue(name, context, includeUser, runPageUrl);
  }

  private get playbookService(): PlaybookService {
    return (this._playbookService ??= getPlaybookService());
  }

  private get noteService(): NoteService {
    return (this._noteService ??= getNoteService());
  }

  /**
   * Process template variables in directive string (async version)
   * Supports {{note:KEY}} syntax for note references
   * Note content is fetched from NoteService using execution's userId
   *
   * Uses iterative resolution to support nested templates like:
   * {{note:latest-metrics-{{projectName}}}} - inner {{projectName}} resolves first,
   * then {{note:latest-metrics-mcp-moira}} resolves in next iteration
   */
  async processDirectiveAsync(directive: string, context: ExecutionContext): Promise<string> {
    return (await this.processDirectiveAsyncWithReport(directive, context)).text;
  }

  /**
   * Same as {@link processDirectiveAsync}, plus the playbook references this call could not
   * resolve.
   *
   * The report belongs to one presentation, not to the processor: handlers are shared between
   * concurrent executions, so a list kept on the instance would attach one run's loss to another.
   */
  async processDirectiveAsyncWithReport(
    directive: string,
    context: ExecutionContext,
  ): Promise<{ text: string; unresolvedPlaybooks: UnresolvedPlaybookReference[] }> {
    const unresolvedPlaybooks: UnresolvedPlaybookReference[] = [];
    const text = await this.processDirectiveAsyncInternal(directive, context, unresolvedPlaybooks);
    return { text, unresolvedPlaybooks };
  }

  private async processDirectiveAsyncInternal(
    directive: string,
    context: ExecutionContext,
    unresolvedPlaybooks: UnresolvedPlaybookReference[],
  ): Promise<string> {
    if (!directive || typeof directive !== "string") {
      return directive;
    }

    // Step 1: Escape \{{ sequences to protect them from processing
    let processed = this.escapeTemplates(directive);
    let prev = "";
    let iterations = 0;
    const maxIterations = 10; // Prevent infinite loops

    // Iterate until no more changes (all templates resolved)
    while (processed !== prev && iterations < maxIterations) {
      prev = processed;

      // First resolve regular templates (sync) - handles {{var}}, {{path.to.value}}, conditionals
      // Use internal version to avoid double-escape handling
      processed = this.processDirectiveInternal(processed, context);

      // Then resolve note references (async) - handles {{note:KEY}}
      processed = await this.processNoteReferences(processed, context);

      // And playbook references - handles {{playbook:NAME}} and {{playbook:@owner/NAME}}
      processed = await this.processPlaybookReferences(processed, context, unresolvedPlaybooks);

      iterations++;
    }

    if (iterations > 1) {
      this.logger?.debug("Nested template resolution completed", {
        executionId: context.executionId,
        iterations,
      });
    }

    // Report residual placeholders after asynchronous template resolution.
    this.warnOnResidualPlaceholder(processed, context);

    // Step final: Restore escaped sequences to literal {{
    return this.unescapeTemplates(processed);
  }

  /**
   * Process {{note:KEY}} references
   * Replaces with note content from NoteService
   * Missing notes produce error message: [NOTE NOT FOUND: KEY]
   */
  private async processNoteReferences(
    directive: string,
    context: ExecutionContext,
  ): Promise<string> {
    // Pattern: {{note:KEY}} where KEY is alphanumeric/underscore/hyphen
    const notePattern = /\{\{note:([a-zA-Z0-9_-]+)\}\}/g;
    const matches = [...directive.matchAll(notePattern)];

    if (matches.length === 0) {
      return directive;
    }

    this.logger?.debug("Processing note references", {
      executionId: context.executionId,
      noteCount: matches.length,
      keys: matches.map((m) => m[1]),
    });

    let result = directive;

    // Process each note reference
    for (const match of matches) {
      const fullMatch = match[0];
      const noteKey = match[1];

      try {
        const note = await this.noteService.get(context.userId, noteKey);
        result = result.replace(fullMatch, note.value);

        this.logger?.debug("Note reference resolved", {
          key: noteKey,
          valueLength: note.value.length,
        });
      } catch (error) {
        if (error instanceof NoteNotFoundError) {
          const errorMsg = `[NOTE NOT FOUND: ${noteKey}]`;
          result = result.replace(fullMatch, errorMsg);

          this.logger?.warn("Note reference not found", {
            key: noteKey,
            userId: context.userId,
          });
        } else {
          const errorMsg = `[NOTE ERROR: ${noteKey}]`;
          result = result.replace(fullMatch, errorMsg);

          this.logger?.error("Note reference error", {
            key: noteKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return result;
  }

  /**
   * Process `{{playbook:NAME}}` and `{{playbook:@owner/NAME}}` references.
   *
   * A playbook is named, reusable behaviour text. The reference is resolved at every step rather
   * than once per run, so editing a playbook reaches a running execution at its next step.
   *
   * A reference that cannot be resolved — the playbook does not exist, or this user may not read
   * it — is replaced with a visible placeholder and recorded, so the run degrades openly instead of
   * quietly losing the text. Identical references in one pass cost one read.
   */
  private async processPlaybookReferences(
    directive: string,
    context: ExecutionContext,
    unresolvedPlaybooks: UnresolvedPlaybookReference[],
  ): Promise<string> {
    const references = collectPlaybookReferences(directive);
    if (references.length === 0) return directive;

    let result = directive;

    for (const reference of references) {
      const { owner, name } = reference;
      const fullMatch = `{{playbook:${reference.text}}}`;

      let replacement: string;
      try {
        const ownerId = await this.playbookService.resolveOwner(owner, context.userId);
        const playbook = ownerId
          ? await this.playbookService.get(context.userId, ownerId, name)
          : null;

        if (playbook) {
          // Another account's text is data, not authoring: it may not be re-read as template
          // syntax, or a published playbook would run as a template inside somebody else's run.
          // Your own playbook is authoring and expands as the rest of your definition does.
          replacement =
            ownerId === context.userId
              ? playbook.content
              : this.neutralizeValueBraces(playbook.content);
        } else {
          replacement = `[PLAYBOOK NOT AVAILABLE: ${reference.text}]`;
          unresolvedPlaybooks.push({ reference: reference.text, reason: "not-found" });
          this.logger?.warn("Playbook reference not available", {
            name,
            owner,
            userId: context.userId,
          });
        }
      } catch (error) {
        replacement = `[PLAYBOOK ERROR: ${reference.text}]`;
        unresolvedPlaybooks.push({ reference: reference.text, reason: "error" });
        this.logger?.error("Playbook reference error", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // One read per distinct reference: `collectPlaybookReferences` already removed duplicates,
      // and every occurrence of this one is replaced at once.
      result = result.split(fullMatch).join(replacement);
    }

    return result;
  }
}
