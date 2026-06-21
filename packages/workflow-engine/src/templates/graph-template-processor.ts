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

import { ExecutionContext } from "../types/index.js";
import { createLogger, getNoteService, NoteService, NoteNotFoundError } from "@mcp-moira/shared";

export interface GraphTemplateContext {
  variables: Record<string, unknown>;
  nodeStates: Record<string, unknown>;
  executionId: string;
  workflowId: string;
  currentNodeId?: string;
}

export class GraphTemplateProcessor {
  private logger = createLogger({ component: "GraphTemplateProcessor" });
  private _noteService: NoteService | null = null;

  /**
   * @param noteService - Optional NoteService for testing. If not provided, will use singleton.
   */
  constructor(noteService?: NoteService) {
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

  /**
   * Placeholder for escaped template syntax during processing.
   * \{{ is replaced with this before processing, then restored to {{ after.
   * Uses null byte delimiters to ensure uniqueness.
   */
  private static readonly ESCAPED_OPEN_BRACE = "\x00__ESCAPED_OPEN_BRACE__\x00";

  /**
   * Template-injection protection (§14).
   *
   * A substituted VALUE that originates from untrusted data (agent step() input,
   * user free-text, node outputs) must NOT be re-interpreted as a template by a
   * later pass — otherwise a value like "{{context.variables}}" would dump the
   * whole variable bag, and "{{#each x}}…{{/each}}" / "{{#if y}}…{{/if}}" injected
   * via data would execute (SSTI-class). So when we splice a value into the
   * directive we neutralize its "{{" by swapping in the escape sentinel; the
   * final unescapeTemplates() restores them to LITERAL "{{" in the output.
   *
   * EXCEPTION — author-controlled template fragments. A small set of registry
   * variables intentionally CARRY template syntax that must still expand
   * (e.g. run_tests_directive → "{{#if test_command}}…{{/if}}"). These are
   * author-authored, not untrusted data, and are identified by naming
   * convention. Their values are spliced verbatim so the second pass expands
   * them. The convention is intentionally narrow.
   */
  private static readonly TEMPLATE_FRAGMENT_VAR =
    /(?:^|[._-])(?:directive|instruction|ctx|fragment|template|prompt|guide|detail|checklist|patterns|practices)$/i;

  /**
   * Compute the authoritative set of template-fragment variable names from a workflow's
   * variableRegistry: a variable whose author-authored `default` is a string containing
   * "{{" intentionally carries template syntax meant to expand (e.g. a *_prompt referencing
   * {{topic}}). This is provenance-based (author default), not name-based, so it never
   * misclassifies runtime agent data (steps/evidence/notes — the injection vectors), which
   * have no template-bearing default.
   */
  static computeFragmentVars(
    registry: Record<string, { default?: unknown }> | undefined,
  ): Set<string> {
    const set = new Set<string>();
    if (!registry) return set;
    for (const [name, def] of Object.entries(registry)) {
      if (def && typeof def.default === "string" && def.default.includes("{{")) {
        set.add(name);
      }
    }
    return set;
  }

  /**
   * True if a variable is an author-controlled template-fragment var (may carry live
   * template syntax that should expand). Two independent author-intent signals, unioned:
   *  (a) PROVENANCE — the variable's registry default carries template syntax (the engine
   *      attaches this set to the context). Catches static-config fragments whose default
   *      embeds a template, regardless of name (e.g. best_practices, research_generation_prompt).
   *  (b) NAME CONVENTION — the variable name ends in a fragment suffix (e.g. *_instruction,
   *      *_directive, *_prompt). Catches author slots whose template is computed at RUNTIME
   *      by an upstream node, so it is absent from the (empty) default (e.g. sdf's
   *      validate_test_instruction = "{{#neq test_info_path 'skip'}}…").
   * Generic agent-output vars (steps/evidence/notes/…) match NEITHER signal, so their values
   * are neutralized (§14 injection protection).
   */
  private isTemplateFragmentVar(varName: string, context?: ExecutionContext): boolean {
    if (context?._templateFragmentVars?.has(varName)) return true;
    return GraphTemplateProcessor.TEMPLATE_FRAGMENT_VAR.test(varName);
  }

  /**
   * Neutralize "{{" inside a substituted value so subsequent passes treat it as
   * literal text, not as a template. Restored to literal "{{" by unescapeTemplates().
   */
  private neutralizeValueBraces(value: string): string {
    return value.split("{{").join(GraphTemplateProcessor.ESCAPED_OPEN_BRACE);
  }

  /**
   * Escape template syntax: replace \{{ with placeholder.
   * Also handles \\{{ → \{{ (literal backslash + literal braces).
   * Called at start of processing to protect escaped sequences.
   */
  private escapeTemplates(text: string): string {
    // First handle double backslash: \\{{ → placeholder for literal backslash + placeholder for braces
    // This allows: \\{{var}} → \{{var}} in output
    let result = text.replace(/\\\\(\{\{)/g, "\\\x00__ESCAPED_OPEN_BRACE__\x00");
    // Then handle single escape: \{{ → placeholder
    result = result.replace(/\\(\{\{)/g, GraphTemplateProcessor.ESCAPED_OPEN_BRACE);
    return result;
  }

  /**
   * Unescape template syntax: restore placeholder to {{.
   * Called at end of processing to produce final output.
   */
  private unescapeTemplates(text: string): string {
    // Use split/join instead of regex to avoid control character issues with ESLint
    return text.split(GraphTemplateProcessor.ESCAPED_OPEN_BRACE).join("{{");
  }

  /**
   * Process template variables in directive string (synchronous version)
   * Does NOT support {{note:KEY}} - use processDirectiveAsync for note references
   */
  processDirective(directive: string, context: ExecutionContext): string {
    if (!directive || typeof directive !== "string") {
      return directive;
    }

    // Step 1: Escape \{{ sequences to protect them from processing
    const escaped = this.escapeTemplates(directive);

    // Step 2: Process templates
    const processed = this.processDirectiveInternal(escaped, context);

    // §10 Fix B: runtime guard — if the rendered directive still contains the
    // undefined-variable placeholder, surface it (was previously silent/debug-only)
    // so the false-loop/undefined class is observable in logs.
    this.warnOnResidualPlaceholder(processed, context);

    // Step 3: Restore escaped sequences to literal {{
    return this.unescapeTemplates(processed);
  }

  /**
   * §10 Fix B — warn when a processed directive still contains UNDEFINED_PLACEHOLDER.
   * The placeholder carries no variable name, so we report the count + executionId.
   */
  private warnOnResidualPlaceholder(processed: string, context: ExecutionContext): void {
    const placeholder = GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;
    if (!processed.includes(placeholder)) return;
    const count = processed.split(placeholder).length - 1;
    this.logger.warn("Directive rendered with unresolved variable placeholder(s)", {
      undefinedPlaceholders: count,
      executionId: context.executionId,
      workflowId: context.workflowId,
    });
  }

  /**
   * Internal template processing without escape handling at entry.
   * Handles escape after each variable substitution to support escaped syntax
   * in variable values (e.g., documentation containing template examples).
   */
  private processDirectiveInternal(directive: string, context: ExecutionContext): string {
    let processed = directive;

    this.logger.debug("Processing directive templates", {
      originalLength: directive.length,
      executionId: context.executionId,
    });

    try {
      // Process conditional templates first (they may contain other templates)
      processed = this.processConditionalTemplates(processed, context);

      // Process all template patterns
      processed = this.processVariableTemplates(processed, context);
      // After variable substitution, escape any \{{ from variable content
      processed = this.escapeTemplates(processed);

      processed = this.processContextTemplates(processed, context);
      processed = this.processNestedPathTemplates(processed, context);

      // Second pass for conditionals: variables may contain conditional templates
      // Example: {{run_tests_directive}} expands to "{{#if test_command}}...{{/if}}"
      if (processed.includes("{{#if") || processed.includes("{{#unless")) {
        processed = this.processConditionalTemplates(processed, context);
        // Process any variables inside the newly expanded conditionals
        processed = this.processVariableTemplates(processed, context);
        // Escape again after second variable substitution
        processed = this.escapeTemplates(processed);
        processed = this.processNestedPathTemplates(processed, context);
      }

      if (processed !== directive) {
        this.logger.debug("Templates processed successfully", {
          originalLength: directive.length,
          processedLength: processed.length,
          templatesDetected: true,
          executionId: context.executionId,
        });
      }
    } catch (error) {
      this.logger.debug("Template processing failed, returning original", {
        error: error instanceof Error ? error.message : String(error),
        executionId: context.executionId,
      });
      return directive;
    }

    return processed;
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

      iterations++;
    }

    if (iterations > 1) {
      this.logger.debug("Nested template resolution completed", {
        executionId: context.executionId,
        iterations,
      });
    }

    // §10 Fix B: runtime guard (async path)
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

    this.logger.debug("Processing note references", {
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

        this.logger.debug("Note reference resolved", {
          key: noteKey,
          valueLength: note.value.length,
        });
      } catch (error) {
        if (error instanceof NoteNotFoundError) {
          const errorMsg = `[NOTE NOT FOUND: ${noteKey}]`;
          result = result.replace(fullMatch, errorMsg);

          this.logger.warn("Note reference not found", {
            key: noteKey,
            userId: context.userId,
          });
        } else {
          const errorMsg = `[NOTE ERROR: ${noteKey}]`;
          result = result.replace(fullMatch, errorMsg);

          this.logger.error("Note reference error", {
            key: noteKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return result;
  }

  /**
   * Process conditional templates: {{#if variable}}...{{else}}...{{/if}}
   * and {{#unless variable}}...{{else}}...{{/unless}}
   * and {{#each array}}...{{/each}}
   * Supports nested conditionals through balanced bracket matching
   */
  private processConditionalTemplates(directive: string, context: ExecutionContext): string {
    let result = directive;
    let iterations = 0;
    const maxIterations = 100; // Prevent infinite loops

    // Process from innermost to outermost by iterating until no more conditionals
    while (iterations < maxIterations) {
      // Process each blocks first (they may contain if/unless)
      let processed = this.processOneEach(result, context);
      if (processed !== result) {
        result = processed;
        iterations++;
        continue;
      }

      // Process neq blocks (not equal comparison)
      processed = this.processOneNeq(result, context);
      if (processed !== result) {
        result = processed;
        iterations++;
        continue;
      }

      // Process eq blocks (equal comparison)
      processed = this.processOneEq(result, context);
      if (processed !== result) {
        result = processed;
        iterations++;
        continue;
      }

      // Process unless blocks
      processed = this.processOneUnless(result, context);
      if (processed !== result) {
        result = processed;
        iterations++;
        continue;
      }

      // Process if blocks
      processed = this.processOneConditional(result, context);
      if (processed === result) {
        // No more conditionals to process
        break;
      }
      result = processed;
      iterations++;
    }

    return result;
  }

  /**
   * Process a single conditional (innermost first)
   * Returns the same string if no conditional found
   */
  private processOneConditional(directive: string, context: ExecutionContext): string {
    // Find {{#if ...}} that doesn't contain nested {{#if
    const ifStart = directive.indexOf("{{#if ");
    if (ifStart === -1) return directive;

    // Find the matching {{/if}}
    let depth = 0;
    let pos = ifStart;
    let ifEnd = -1;

    while (pos < directive.length) {
      if (directive.startsWith("{{#if ", pos)) {
        depth++;
        pos += 6;
      } else if (directive.startsWith("{{/if}}", pos)) {
        depth--;
        if (depth === 0) {
          ifEnd = pos + 7;
          break;
        }
        pos += 7;
      } else {
        pos++;
      }
    }

    if (ifEnd === -1) {
      // Unbalanced conditional, return as-is
      this.logger.debug("Unbalanced conditional template", {
        directive: directive.substring(0, 100),
      });
      return directive;
    }

    // Extract the full conditional block
    const fullBlock = directive.substring(ifStart, ifEnd);

    // Parse the conditional block
    const varNameMatch = fullBlock.match(/^\{\{#if\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\}\}/);
    if (!varNameMatch) return directive;

    const varPath = varNameMatch[1];
    const contentStart = varNameMatch[0].length;
    const contentEnd = fullBlock.length - 7; // Remove {{/if}}
    const content = fullBlock.substring(contentStart, contentEnd);

    // Find {{else}} at depth 0 within this block
    let elsePos = -1;
    depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.startsWith("{{#if ", i)) {
        depth++;
      } else if (content.startsWith("{{/if}}", i)) {
        depth--;
      } else if (depth === 0 && content.startsWith("{{else}}", i)) {
        elsePos = i;
        break;
      }
    }

    let ifContent: string;
    let elseContent: string;

    if (elsePos !== -1) {
      ifContent = content.substring(0, elsePos);
      elseContent = content.substring(elsePos + 8); // Skip {{else}}
    } else {
      ifContent = content;
      elseContent = "";
    }

    // Evaluate the condition
    const value = this.getNestedValue(context.variables, varPath);
    const isTruthy = this.isTruthy(value);

    this.logger.debug("Processing conditional template", {
      varPath,
      isTruthy,
      hasElse: elsePos !== -1,
    });

    const replacement = isTruthy ? ifContent : elseContent;

    // Replace the full block with the result
    return directive.substring(0, ifStart) + replacement + directive.substring(ifEnd);
  }

  /**
   * Process a single {{#unless variable}}...{{else}}...{{/unless}} block
   * Returns the same string if no unless found
   */
  private processOneUnless(directive: string, context: ExecutionContext): string {
    // Find {{#unless ...}} that doesn't contain nested {{#unless
    const unlessStart = directive.indexOf("{{#unless ");
    if (unlessStart === -1) return directive;

    // Find the matching {{/unless}}
    let depth = 0;
    let pos = unlessStart;
    let unlessEnd = -1;

    while (pos < directive.length) {
      if (directive.startsWith("{{#unless ", pos)) {
        depth++;
        pos += 10;
      } else if (directive.startsWith("{{/unless}}", pos)) {
        depth--;
        if (depth === 0) {
          unlessEnd = pos + 11;
          break;
        }
        pos += 11;
      } else {
        pos++;
      }
    }

    if (unlessEnd === -1) {
      // Unbalanced unless, return as-is
      this.logger.debug("Unbalanced unless template", { directive: directive.substring(0, 100) });
      return directive;
    }

    // Extract the full unless block
    const fullBlock = directive.substring(unlessStart, unlessEnd);

    // Parse the unless block
    const varNameMatch = fullBlock.match(/^\{\{#unless\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\}\}/);
    if (!varNameMatch) return directive;

    const varPath = varNameMatch[1];
    const contentStart = varNameMatch[0].length;
    const contentEnd = fullBlock.length - 11; // Remove {{/unless}}
    const content = fullBlock.substring(contentStart, contentEnd);

    // Find {{else}} at depth 0 within this block
    let elsePos = -1;
    depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.startsWith("{{#unless ", i)) {
        depth++;
      } else if (content.startsWith("{{/unless}}", i)) {
        depth--;
      } else if (depth === 0 && content.startsWith("{{else}}", i)) {
        elsePos = i;
        break;
      }
    }

    let unlessContent: string;
    let elseContent: string;

    if (elsePos !== -1) {
      unlessContent = content.substring(0, elsePos);
      elseContent = content.substring(elsePos + 8); // Skip {{else}}
    } else {
      unlessContent = content;
      elseContent = "";
    }

    // Evaluate the condition - unless is opposite of if
    const value = this.getNestedValue(context.variables, varPath);
    const isTruthy = this.isTruthy(value);

    this.logger.debug("Processing unless template", {
      varPath,
      isTruthy,
      hasElse: elsePos !== -1,
    });

    // Unless shows content when value is FALSY (opposite of if)
    const replacement = isTruthy ? elseContent : unlessContent;

    // Replace the full block with the result
    return directive.substring(0, unlessStart) + replacement + directive.substring(unlessEnd);
  }

  /**
   * Process a single {{#neq variable 'value'}}...{{else}}...{{/neq}} block
   * Shows content when variable does NOT equal the specified value
   * Returns the same string if no neq found
   */
  private processOneNeq(directive: string, context: ExecutionContext): string {
    // Find {{#neq ...}}
    const neqStart = directive.indexOf("{{#neq ");
    if (neqStart === -1) return directive;

    // Find the matching {{/neq}}
    let depth = 0;
    let pos = neqStart;
    let neqEnd = -1;

    while (pos < directive.length) {
      if (directive.startsWith("{{#neq ", pos)) {
        depth++;
        pos += 7;
      } else if (directive.startsWith("{{/neq}}", pos)) {
        depth--;
        if (depth === 0) {
          neqEnd = pos + 8;
          break;
        }
        pos += 8;
      } else {
        pos++;
      }
    }

    if (neqEnd === -1) {
      this.logger.debug("Unbalanced neq template", { directive: directive.substring(0, 100) });
      return directive;
    }

    // Extract the full neq block
    const fullBlock = directive.substring(neqStart, neqEnd);

    // Parse the neq block - supports {{#neq varName 'value'}} or {{#neq varName "value"}}
    const varNameMatch = fullBlock.match(
      /^\{\{#neq\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\s+['"]([^'"]*)['"]\}\}/,
    );
    if (!varNameMatch) {
      this.logger.debug("Invalid neq syntax", { block: fullBlock.substring(0, 50) });
      return directive;
    }

    const varPath = varNameMatch[1];
    const compareValue = varNameMatch[2];
    const contentStart = varNameMatch[0].length;
    const contentEnd = fullBlock.length - 8; // Remove {{/neq}}
    const content = fullBlock.substring(contentStart, contentEnd);

    // Find {{else}} at depth 0 within this block
    let elsePos = -1;
    depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.startsWith("{{#neq ", i)) {
        depth++;
      } else if (content.startsWith("{{/neq}}", i)) {
        depth--;
      } else if (depth === 0 && content.startsWith("{{else}}", i)) {
        elsePos = i;
        break;
      }
    }

    let neqContent: string;
    let elseContent: string;

    if (elsePos !== -1) {
      neqContent = content.substring(0, elsePos);
      elseContent = content.substring(elsePos + 8); // Skip {{else}}
    } else {
      neqContent = content;
      elseContent = "";
    }

    // Get the variable value and compare
    const value = this.getNestedValue(context.variables, varPath);
    const stringValue = value === null || value === undefined ? "" : String(value);
    const isNotEqual = stringValue !== compareValue;

    this.logger.debug("Processing neq template", {
      varPath,
      compareValue,
      actualValue: stringValue,
      isNotEqual,
      hasElse: elsePos !== -1,
    });

    // Show neqContent when NOT equal, elseContent when equal
    const replacement = isNotEqual ? neqContent : elseContent;

    return directive.substring(0, neqStart) + replacement + directive.substring(neqEnd);
  }

  /**
   * Process a single {{#eq variable 'value'}}...{{else}}...{{/eq}} block
   * Shows content when variable equals the specified value
   * Returns the same string if no eq found
   */
  private processOneEq(directive: string, context: ExecutionContext): string {
    // Find {{#eq ...}}
    const eqStart = directive.indexOf("{{#eq ");
    if (eqStart === -1) return directive;

    // Find the matching {{/eq}}
    let depth = 0;
    let pos = eqStart;
    let eqEnd = -1;

    while (pos < directive.length) {
      if (directive.startsWith("{{#eq ", pos)) {
        depth++;
        pos += 6;
      } else if (directive.startsWith("{{/eq}}", pos)) {
        depth--;
        if (depth === 0) {
          eqEnd = pos + 7;
          break;
        }
        pos += 7;
      } else {
        pos++;
      }
    }

    if (eqEnd === -1) {
      this.logger.debug("Unbalanced eq template", { directive: directive.substring(0, 100) });
      return directive;
    }

    // Extract the full eq block
    const fullBlock = directive.substring(eqStart, eqEnd);

    // Parse the eq block - supports {{#eq varName 'value'}} or {{#eq varName "value"}}
    const varNameMatch = fullBlock.match(
      /^\{\{#eq\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\s+['"]([^'"]*)['"]\}\}/,
    );
    if (!varNameMatch) {
      this.logger.debug("Invalid eq syntax", { block: fullBlock.substring(0, 50) });
      return directive;
    }

    const varPath = varNameMatch[1];
    const compareValue = varNameMatch[2];
    const contentStart = varNameMatch[0].length;
    const contentEnd = fullBlock.length - 7; // Remove {{/eq}}
    const content = fullBlock.substring(contentStart, contentEnd);

    // Find {{else}} at depth 0 within this block
    let elsePos = -1;
    depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.startsWith("{{#eq ", i)) {
        depth++;
      } else if (content.startsWith("{{/eq}}", i)) {
        depth--;
      } else if (depth === 0 && content.startsWith("{{else}}", i)) {
        elsePos = i;
        break;
      }
    }

    let eqContent: string;
    let elseContent: string;

    if (elsePos !== -1) {
      eqContent = content.substring(0, elsePos);
      elseContent = content.substring(elsePos + 8); // Skip {{else}}
    } else {
      eqContent = content;
      elseContent = "";
    }

    // Get the variable value and compare
    const value = this.getNestedValue(context.variables, varPath);
    const stringValue = value === null || value === undefined ? "" : String(value);
    const isEqual = stringValue === compareValue;

    this.logger.debug("Processing eq template", {
      varPath,
      compareValue,
      actualValue: stringValue,
      isEqual,
      hasElse: elsePos !== -1,
    });

    // Show eqContent when equal, elseContent when not equal
    const replacement = isEqual ? eqContent : elseContent;

    return directive.substring(0, eqStart) + replacement + directive.substring(eqEnd);
  }

  /**
   * Process a single {{#each array}}...{{/each}} block
   * Supports {{this}}, {{@index}}, and {{fieldName}} inside the loop
   * Returns the same string if no each found
   */
  private processOneEach(directive: string, context: ExecutionContext): string {
    // Find {{#each ...}}
    const eachStart = directive.indexOf("{{#each ");
    if (eachStart === -1) return directive;

    // Find the matching {{/each}}
    let depth = 0;
    let pos = eachStart;
    let eachEnd = -1;

    while (pos < directive.length) {
      if (directive.startsWith("{{#each ", pos)) {
        depth++;
        pos += 8;
      } else if (directive.startsWith("{{/each}}", pos)) {
        depth--;
        if (depth === 0) {
          eachEnd = pos + 9;
          break;
        }
        pos += 9;
      } else {
        pos++;
      }
    }

    if (eachEnd === -1) {
      // Unbalanced each, return as-is
      this.logger.debug("Unbalanced each template", { directive: directive.substring(0, 100) });
      return directive;
    }

    // Extract the full each block
    const fullBlock = directive.substring(eachStart, eachEnd);

    // Parse the each block - supports {{#each arrayName}} or {{#each nested.path}}
    // First segment supports kebab-case (e.g., {{#each my-items}}, {{#each data-source.results}})
    const varNameMatch = fullBlock.match(
      /^\{\{#each\s+([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}\}/,
    );
    if (!varNameMatch) return directive;

    const varPath = varNameMatch[1];
    const contentStart = varNameMatch[0].length;
    const contentEnd = fullBlock.length - 9; // Remove {{/each}}
    const template = fullBlock.substring(contentStart, contentEnd);

    // Get the array value
    const arrayValue = this.getNestedValue(context.variables, varPath);

    this.logger.debug("Processing each template", {
      varPath,
      isArray: Array.isArray(arrayValue),
      length: Array.isArray(arrayValue) ? arrayValue.length : 0,
    });

    // If not an array or empty, remove the block
    if (!Array.isArray(arrayValue) || arrayValue.length === 0) {
      return directive.substring(0, eachStart) + directive.substring(eachEnd);
    }

    // Process each item
    const results: string[] = [];
    for (let index = 0; index < arrayValue.length; index++) {
      const item = arrayValue[index];
      let itemResult = template;

      // Replace {{@index}} with current index
      itemResult = itemResult.replace(/\{\{@index\}\}/g, String(index));

      // Replace {{this}} with the current item
      if (typeof item === "object" && item !== null) {
        // For objects, serialize the whole object
        itemResult = itemResult.replace(/\{\{this\}\}/g, this.safeSerialize(item));

        // Replace {{this.fieldName}} and {{this.nested.path}} with item field access
        const thisFieldPattern = /\{\{this\.([a-zA-Z_][a-zA-Z0-9_.-]*)\}\}/g;
        itemResult = itemResult.replace(thisFieldPattern, (_match, fieldPath: string) => {
          const value = this.getNestedValue(item, fieldPath);
          return this.safeSerialize(value);
        });

        // Process conditionals with item context merged into variables
        // This allows {{#if done}} to work where 'done' is a field of the item
        const itemContext: ExecutionContext = {
          ...context,
          variables: { ...context.variables, ...(item as Record<string, unknown>) },
        };

        // Process conditionals (if/unless) with item context
        // They need access to item fields for conditions like {{#if done}}
        let prevResult = "";
        let iterations = 0;
        while (itemResult !== prevResult && iterations < 50) {
          prevResult = itemResult;
          // Process unless blocks with item context
          const unlessResult = this.processOneUnlessWithContext(itemResult, itemContext);
          if (unlessResult !== itemResult) {
            itemResult = unlessResult;
            iterations++;
            continue;
          }
          // Process if blocks with item context
          const ifResult = this.processOneConditionalWithContext(itemResult, itemContext);
          if (ifResult !== itemResult) {
            itemResult = ifResult;
            iterations++;
            continue;
          }
          break;
        }

        // Replace {{fieldName}} with item.fieldName for direct field access
        const fieldPattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
        itemResult = itemResult.replace(fieldPattern, (match, fieldName) => {
          // Skip special keywords
          if (fieldName === "this") return match;

          const fieldValue = (item as Record<string, unknown>)[fieldName];
          if (fieldValue !== undefined) {
            return this.safeSerialize(fieldValue);
          }
          return match; // Keep original if field not found in item
        });
      } else {
        // For primitives, this is the value itself
        itemResult = itemResult.replace(/\{\{this\}\}/g, this.safeSerialize(item));
      }

      results.push(itemResult);
    }

    // Replace the full block with the concatenated results
    return directive.substring(0, eachStart) + results.join("") + directive.substring(eachEnd);
  }

  /**
   * Process one conditional with explicit context (for use inside each loops)
   */
  private processOneConditionalWithContext(directive: string, context: ExecutionContext): string {
    return this.processOneConditional(directive, context);
  }

  /**
   * Process one unless with explicit context (for use inside each loops)
   */
  private processOneUnlessWithContext(directive: string, context: ExecutionContext): string {
    return this.processOneUnless(directive, context);
  }

  /**
   * Evaluate truthiness of a value for conditional templates
   * Falsy: null, undefined, false, 0, "", empty array, empty object
   */
  private isTruthy(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (value === false) return false;
    if (value === 0) return false;
    if (value === "") return false;
    // Treat string "no" and "false" as falsy (common in workflow schemas with yes/no enums)
    if (value === "no" || value === "false") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === "object" && Object.keys(value).length === 0) return false;
    return true;
  }

  /**
   * Process simple variable templates: {{variableName}}
   * Includes both user variables and system context (executionId, workflowId)
   * Excludes control flow keywords: else, if, unless, /if, /unless
   */
  private processVariableTemplates(directive: string, context: ExecutionContext): string {
    // Pattern supports kebab-case for node IDs (e.g., {{setup-workspace}})
    const simpleVariablePattern = /\{\{([a-zA-Z_][a-zA-Z0-9_-]*)\}\}/g;
    // Reserved keywords used in conditional templates
    const reservedKeywords = new Set(["else", "if", "unless"]);

    return directive.replace(simpleVariablePattern, (match, varName) => {
      // Skip reserved control flow keywords
      if (reservedKeywords.has(varName)) {
        return match; // Return unchanged
      }
      try {
        let value: unknown;

        // Check system context first (executionId, workflowId)
        if (varName === "executionId") {
          value = context.executionId;
        } else if (varName === "workflowId") {
          value = context.workflowId;
        } else {
          // Check user variables
          value = context.variables[varName];
        }

        const serialized = this.safeSerialize(value);

        this.logger.debug("Replaced simple variable template", {
          varName,
          found: value !== undefined,
          isSystemVar: ["executionId", "workflowId"].includes(varName),
          serializedLength: serialized.length,
        });

        // §14 injection protection: only author-controlled fragment vars may carry
        // live template syntax; all other (data) values are neutralized so a later
        // pass cannot execute "{{context.variables}}" / "{{#each}}" injected via data.
        return this.isTemplateFragmentVar(varName, context)
          ? serialized
          : this.neutralizeValueBraces(serialized);
      } catch (error) {
        this.logger.debug("Failed to process variable template", {
          varName,
          error: error instanceof Error ? error.message : String(error),
        });
        return GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;
      }
    });
  }

  /**
   * Process context access templates: {{context.variables}}
   */
  private processContextTemplates(directive: string, context: ExecutionContext): string {
    const contextPattern = /\{\{context\.variables\}\}/g;

    return directive.replace(contextPattern, () => {
      try {
        const serialized = this.safeSerialize(context.variables);

        this.logger.debug("Replaced context.variables template", {
          variableCount: Object.keys(context.variables).length,
          serializedLength: serialized.length,
        });

        // §14: the dumped variable bag is data — neutralize so embedded "{{…}}"
        // from variable values cannot be re-executed by a later pass.
        return this.neutralizeValueBraces(serialized);
      } catch (error) {
        this.logger.debug("Failed to process context template", { error });
        return "{}";
      }
    });
  }

  /**
   * Process nested path templates: {{user.name}}, {{items[0].value}}, {{data[1].items[0].name}}
   * Supports arbitrary combinations of .field and [index] accessors
   * Supports dynamic array indexes: {{items[idx].field}} where idx is a variable
   * Excludes control flow keywords: else, if, unless
   */
  private processNestedPathTemplates(directive: string, context: ExecutionContext): string {
    // Pattern supports: identifier followed by any combination of .field or [index] or [varname]
    // First segment supports kebab-case for node IDs (e.g., setup-workspace.field)
    // Examples: user.name, items[0], setup-workspace.path, data[1].items[0].value
    // Dynamic indexes: items[idx], matrix[row][col], steps[current_step].action
    // Index content: either digits (\d+) or variable name ([a-zA-Z_][a-zA-Z0-9_]*)
    const nestedPathPattern =
      /\{\{([a-zA-Z_][a-zA-Z0-9_-]*(?:(?:\.[a-zA-Z_][a-zA-Z0-9_]*)|(?:\[(?:\d+|[a-zA-Z_][a-zA-Z0-9_]*)\]))*)\}\}/g;
    // Reserved keywords used in conditional templates
    const reservedKeywords = new Set(["else", "if", "unless"]);

    return directive.replace(nestedPathPattern, (match, path) => {
      // Skip reserved control flow keywords (simple match without path separators)
      if (reservedKeywords.has(path)) {
        return match; // Return unchanged
      }
      try {
        const value = this.getNestedValue(context.variables, path, context.variables);
        const serialized = this.safeSerialize(value);

        this.logger.debug("Replaced nested path template", {
          path,
          found: value !== undefined,
          serializedLength: serialized.length,
        });

        // §14 injection protection: node-path values are data — neutralize so
        // an injected "{{context.variables}}"/"{{#each}}" cannot execute downstream.
        return this.neutralizeValueBraces(serialized);
      } catch (error) {
        this.logger.debug("Failed to process nested path template", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;
      }
    });
  }

  /**
   * Get nested value from object using path
   * @param obj - The object to traverse
   * @param path - The path string (e.g., "user.name", "items[0].value", "items[idx].field")
   * @param variables - Optional variables context for resolving dynamic array indexes
   */
  private getNestedValue(obj: unknown, path: string, variables?: Record<string, unknown>): unknown {
    if (!path) return obj;

    const segments = this.parsePath(path, variables);
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (typeof segment === "string") {
        current =
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[segment]
            : undefined;
      } else if (typeof segment === "number") {
        if (Array.isArray(current)) {
          current = current[segment];
        } else {
          return undefined;
        }
      }
    }

    return current;
  }

  /**
   * Parse path into segments (user.name[0] → ["user", "name", 0])
   * Supports dynamic array indexes: items[idx] where idx is resolved from variables
   * @param path - The path string to parse
   * @param variables - Optional variables context for resolving dynamic array indexes
   */
  private parsePath(path: string, variables?: Record<string, unknown>): (string | number)[] {
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

        // Parse array index (can be numeric literal or variable name)
        i++;
        let indexStr = "";
        while (i < path.length && path[i] !== "]") {
          indexStr += path[i];
          i++;
        }

        if (i >= path.length) {
          throw new Error(`Unclosed array bracket in path: ${path}`);
        }

        // Check if it's a numeric literal
        const numericIndex = parseInt(indexStr, 10);
        if (!isNaN(numericIndex) && /^\d+$/.test(indexStr)) {
          // Pure numeric literal
          segments.push(numericIndex);
        } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(indexStr)) {
          // Variable name - resolve from context
          if (variables) {
            const resolvedValue = variables[indexStr];
            if (typeof resolvedValue === "number") {
              // Valid numeric index from variable
              if (resolvedValue < 0 || !Number.isInteger(resolvedValue)) {
                // Negative or non-integer - treat as invalid index
                throw new Error(
                  `Invalid array index from variable '${indexStr}': ${resolvedValue}`,
                );
              }
              segments.push(resolvedValue);
            } else if (typeof resolvedValue === "string") {
              // Try to parse string as number
              const parsedIndex = parseInt(resolvedValue, 10);
              if (!isNaN(parsedIndex) && /^\d+$/.test(resolvedValue)) {
                if (parsedIndex < 0) {
                  throw new Error(
                    `Invalid array index from variable '${indexStr}': ${parsedIndex}`,
                  );
                }
                segments.push(parsedIndex);
              } else {
                // Non-numeric string - invalid
                throw new Error(
                  `Variable '${indexStr}' does not resolve to a valid index: ${resolvedValue}`,
                );
              }
            } else {
              // undefined, null, object, etc. - invalid
              throw new Error(
                `Variable '${indexStr}' does not resolve to a valid index: ${resolvedValue}`,
              );
            }
          } else {
            // No variables context provided - cannot resolve dynamic index
            throw new Error(`Cannot resolve dynamic index '${indexStr}' without variables context`);
          }
        } else {
          throw new Error(`Invalid array index in path: ${path}`);
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
   * Placeholder for undefined/null variables - easily detectable in tests
   * Using unique format that won't appear in normal text
   */
  static readonly UNDEFINED_PLACEHOLDER = "[[UNDEFINED_VARIABLE]]";

  /**
   * Safely serialize values for template substitution
   * Avoids adding quotes to simple strings (fixes telegram message formatting)
   * Returns UNDEFINED_PLACEHOLDER for null/undefined to make missing variables detectable
   */
  private safeSerialize(value: unknown, depth: number = 0): string {
    if (depth > 10) return "[Circular]"; // Prevent infinite recursion

    if (value === null || value === undefined) {
      return GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;
    }

    // Handle primitive types without JSON.stringify quotes
    if (typeof value === "string") {
      return value; // Return string as-is (no quotes)
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value); // Convert to string without quotes
    }

    // Handle arrays with consistent formatting
    if (Array.isArray(value)) {
      try {
        const items = value.map((item) =>
          typeof item === "string" ? item : this.safeSerialize(item, depth + 1),
        );
        return `[${items.join(",")}]`;
      } catch {
        return "[]";
      }
    }

    // Handle objects with consistent formatting
    if (value && typeof value === "object") {
      try {
        const entries = Object.entries(value).map(([key, val]) => {
          const serializedVal =
            typeof val === "string" ? `"${val}"` : this.safeSerialize(val, depth + 1);
          return `"${key}":${serializedVal}`;
        });
        return `{${entries.join(",")}}`;
      } catch {
        return "{}";
      }
    }

    // Fallback for other types
    return String(value);
  }

  /**
   * Extract available template variables for debugging
   */
  getAvailableVariables(context: ExecutionContext): string[] {
    const collectKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
      const keys: string[] = [];

      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.push(fullKey);

        if (value && typeof value === "object" && !Array.isArray(value)) {
          // Recursively collect nested keys (limit depth to 3)
          if (prefix.split(".").length < 3) {
            keys.push(...collectKeys(value as Record<string, unknown>, fullKey));
          }
        }
      }

      return keys;
    };

    return collectKeys(context.variables);
  }
}
