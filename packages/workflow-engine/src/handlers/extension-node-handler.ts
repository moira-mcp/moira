/**
 * Extension node handler — executes a custom node type out-of-process.
 *
 * This handler is Moira code, not extension code: it template-processes the node's configuration and
 * input, checks them against the schemas the extension declared, hands a serialisable call to the
 * runner client and checks the returned result the same way. Five causes (configuration or input not
 * matching its schema, handler error, timeout, runner unavailable, result not matching its schema)
 * all route to `error` with diagnostics that name the cause, because a custom node's result is
 * consumed by later nodes and a silent `default` would hide it.
 */

import * as AjvModule from "ajv";
import { ExecutionContext, GraphNode, ExtensionNode, isExtensionNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { createLogger, WorkflowLogger, InternalError } from "@mcp-moira/shared";
import { ExtensionRegistry } from "../extensions/extension-registry.js";
import { ExtensionPermissions } from "../extensions/extension-contract.js";
import { extensionSettingDefinition } from "../extensions/extension-settings.js";
import { canonicalJson, DECLARED_SCHEMA_AJV_OPTIONS } from "../extensions/declared-schema.js";
import {
  ExtensionFailureKind,
  ExtensionInvocationError,
  IExtensionRunnerClient,
} from "../extensions/extension-runner-client.js";

/** Default call deadline when the node does not set one. */
export const DEFAULT_EXTENSION_TIMEOUT_MS = 30_000;

export class ExtensionNodeHandler implements INodeHandler {
  private templateProcessor = new GraphTemplateProcessor();
  private logger: WorkflowLogger;
  // Ajv ships as CommonJS; the rest of the engine constructs it through the module default too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ajv = new (AjvModule as any).default(DECLARED_SCHEMA_AJV_OPTIONS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private schemaValidators = new Map<string, any>();

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly client: IExtensionRunnerClient | null,
  ) {
    this.logger = createLogger({ component: "ExtensionNodeHandler" });
  }

  /**
   * The handler serves every registered custom type rather than one fixed type, so the value
   * returned here is a marker used by the engine's handler map, not a workflow node type.
   */
  getNodeType(): string {
    return "extension";
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isExtensionNode(node) && this.registry.has(node.type);
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isExtensionNode(node)) {
      throw new InternalError("ExtensionNodeHandler can only execute extension nodes", {
        nodeType: node.type,
      });
    }

    const registered = this.registry.get(node.type);
    if (!registered) {
      // An unplugged extension is a distinct state from an unknown type: say which extension.
      throw new InternalError(
        `Node type '${node.type}' belongs to an extension that is not currently installed`,
        { nodeId: node.id, nodeType: node.type },
      );
    }

    // Refusing here is deliberate: without a configured client there is no out-of-process path,
    // and substituting an in-process stand-in would silently break the isolation contract.
    if (!this.client) {
      throw new InternalError(
        `Extension runner is not configured; node type '${node.type}' cannot be executed`,
        { nodeId: node.id, nodeType: node.type },
      );
    }

    const extensionNode = node as ExtensionNode;
    // Templates are processed before validation, not after: the handler receives the substituted
    // values, so those are the values that have to match the declaration. Validating the authored
    // text instead would accept `{{count}}` for a number and hand the handler whatever the variable
    // happened to hold.
    const config = this.processValues(extensionNode.config, context);
    const input = this.processValues(extensionNode.input, context);

    const configErrors = this.validateAgainst(
      `${extensionNode.type}#config`,
      registered.declaration.configSchema,
      config,
    );
    if (configErrors) {
      return this.routeFailure(
        extensionNode,
        messageQueue,
        "invalid-input",
        `Node configuration does not match the configSchema declared by '${registered.extensionName}': ${configErrors}`,
      );
    }

    if (registered.declaration.inputSchema) {
      const inputErrors = this.validateAgainst(
        `${extensionNode.type}#input`,
        registered.declaration.inputSchema,
        input,
      );
      if (inputErrors) {
        return this.routeFailure(
          extensionNode,
          messageQueue,
          "invalid-input",
          `Node input does not match the inputSchema declared by '${registered.extensionName}': ${inputErrors}`,
        );
      }
    }

    // Values of the settings this extension was granted, resolved for the user the execution
    // belongs to. Resolving here rather than in the runner keeps the values on Moira's side of the
    // boundary until the moment they are needed, and keeps the grant list — the manifest's — the
    // only thing that decides what crosses.
    const secrets = await this.resolveGrantedSecrets(
      registered.extensionName,
      registered.permissions,
      context,
      repository,
    );

    try {
      const result = await this.client.invoke({
        nodeType: extensionNode.type,
        nodeId: extensionNode.id,
        executionId: context.executionId,
        workflowId: context.workflowId,
        config,
        input,
        timeoutMs: extensionNode.timeout ?? DEFAULT_EXTENSION_TIMEOUT_MS,
        ...(secrets ? { secrets } : {}),
      });

      const schemaErrors = this.validateAgainst(
        `${extensionNode.type}#output`,
        registered.declaration.outputSchema,
        result.output,
      );
      if (schemaErrors) {
        return this.routeFailure(
          extensionNode,
          messageQueue,
          "invalid-output",
          `Extension '${registered.extensionName}' returned a result that does not match its declared outputSchema: ${schemaErrors}`,
        );
      }

      this.logger.info("Extension node executed", {
        nodeId: extensionNode.id,
        nodeType: extensionNode.type,
        executionId: context.executionId,
      });

      // Result goes to the node-local scope through the engine's ordinary routing; extension
      // nodes declare no global writes, so later nodes read fields as `{{node-id.field}}`.
      // Artifacts land beside the declared output rather than inside it: they are not part of the
      // schema the extension declared, and validating them against it would reject every handler
      // that writes one.
      const data = result.artifacts?.length
        ? { ...result.output, artifacts: result.artifacts }
        : result.output;
      return NodeResultBuilder.continue(extensionNode.id, "success", data);
    } catch (error) {
      const kind: ExtensionFailureKind =
        error instanceof ExtensionInvocationError ? error.kind : "handler-error";
      const message = error instanceof Error ? error.message : String(error);
      return this.routeFailure(extensionNode, messageQueue, kind, message);
    }
  }

  /**
   * Setting values for the aliases the manifest was granted, or undefined when it asked for none.
   *
   * A granted alias with no stored value is `null` rather than absent: the handler must be able to
   * tell "the administrator has not filled this in" from "this extension may not read it", and the
   * second is a refusal the runner raises by name.
   */
  private async resolveGrantedSecrets(
    extensionName: string,
    permissions: ExtensionPermissions | undefined,
    context: ExecutionContext,
    repository: IDataRepository,
  ): Promise<Record<string, string | null> | undefined> {
    const aliases = permissions?.secrets ?? [];
    if (aliases.length === 0) return undefined;

    const resolved: Record<string, string | null> = {};
    for (const alias of aliases) {
      // The alias must resolve to a setting this extension *declares*, not merely to a key that
      // starts with its name. A prefix test would still read a value that lives elsewhere: Moira's
      // own settings, or a row an administrator happened to create with a matching key, both of
      // which the ordinary settings repository would decrypt and hand over. Reading only declared
      // settings makes the manifest the single source of what an extension can see.
      const declared = extensionSettingDefinition(alias, this.registry);
      if (!declared || declared.extensionName !== extensionName) {
        this.logger.warn("Refusing a secret alias the extension does not declare", {
          extensionName,
          alias,
        });
        continue;
      }
      const value = await repository.getSetting<unknown>(context.userId, alias);
      // Serialised, not stringified: a structural setting reads back as an object, and `String`
      // would hand the handler `[object Object]` with no error to notice. The transport carries
      // text, so an object crosses as its JSON.
      resolved[alias] =
        value === null || value === undefined
          ? null
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    }
    return resolved;
  }

  /**
   * Template-process the string values of a node's authored map, like other nodes do.
   *
   * The walk goes all the way down. An extension declares its own `configSchema`, so a nested
   * object or an array of strings is an ordinary shape here, and a template left unsubstituted
   * inside one would reach the handler as the literal text `{{name}}` — accepted by the schema,
   * because it is still a string, and wrong in a way nothing downstream can see.
   */
  private processValues(
    values: Record<string, unknown> | undefined,
    context: ExecutionContext,
  ): Record<string, unknown> {
    return this.processValue(values ?? {}, context) as Record<string, unknown>;
  }

  private processValue(value: unknown, context: ExecutionContext): unknown {
    if (typeof value === "string") {
      return this.templateProcessor.processDirective(value, context);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.processValue(item, context));
    }
    if (value !== null && typeof value === "object") {
      const processed: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        processed[key] = this.processValue(nested, context);
      }
      return processed;
    }
    return value;
  }

  /** Returns a readable error list when a value violates its schema, or null when it matches. */
  private validateAgainst(
    cacheKey: string,
    schema: Record<string, unknown>,
    value: unknown,
  ): string | null {
    const schemaCacheKey = `${cacheKey}\u0000${canonicalJson(schema)}`;
    let validate = this.schemaValidators.get(schemaCacheKey);
    if (!validate) {
      try {
        validate = this.ajv.compile(schema);
      } catch (error) {
        // A schema the manifest check accepted compiles here too — the options are the same. If it
        // ever does not, the node fails by name and routes to `error`, which is what an extension
        // defect must look like from a workflow.
        return `declared schema could not be compiled: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      this.schemaValidators.set(schemaCacheKey, validate);
    }
    if (validate(value)) return null;
    const errors = (validate.errors ?? []) as Array<{ instancePath?: string; message?: string }>;
    return errors
      .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`)
      .join("; ");
  }

  private routeFailure(
    node: ExtensionNode,
    messageQueue: AgentMessageQueue,
    kind: ExtensionFailureKind,
    message: string,
  ): NodeExecutionResult {
    this.logger.warn("Extension node failed", { nodeId: node.id, nodeType: node.type, kind });
    messageQueue.addNotification(node.id, `${describeFailure(kind)}: ${message}`, kind);

    const data = {
      extensionFailed: true,
      failureKind: kind,
      errorMessage: message,
      timestamp: Date.now(),
    };

    if (node.connections.error) {
      return NodeResultBuilder.continue(node.id, "error", data);
    }
    // Without an `error` connection there is nowhere to route the failure, and continuing on
    // success would feed later nodes a result the extension never produced. The engine turns this
    // result into a pause on this node: the diagnostic is logged and shown to the agent, execution
    // stays running, and the next step re-invokes the extension.
    return NodeResultBuilder.error(node.id, `${describeFailure(kind)}: ${message}`);
  }
}

function describeFailure(kind: ExtensionFailureKind): string {
  switch (kind) {
    case "timeout":
      return "Extension call exceeded its deadline";
    case "runner-unavailable":
      return "Extension runner is unavailable";
    case "invalid-output":
      return "Extension returned an invalid result";
    case "handler-error":
      return "Extension handler failed";
    case "invalid-input":
      return "Extension node was not called";
  }
}
