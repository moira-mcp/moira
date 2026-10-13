import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodespaceConnectionError,
  LocalDeviceError,
  CodespaceResourceError,
  createLogger,
  projectCodespaceSummary,
  recordCodespaceRejection,
  localCodespaceFailureGuidance,
  LOCAL_WORKER_REQUEST_TIMEOUT_MS,
  type CodespaceObservabilityService,
  type CodespaceConnectionService,
  type CodespaceGuidanceSituation,
  type CodespaceProviderGuidance,
  type CodespaceResourceRecord,
  type CodespaceResourceService,
} from "@mcp-moira/shared";
import { z } from "zod";
import { WORKSPACE_REQUEST_ID_PATTERN } from "@mcp-moira/shared/workspace-request-id";
import { getUserContext } from "../core/request-context.js";
import {
  executeWorkspaceAction,
  type WorkspaceToolClient,
  type WorkspaceAttachments,
} from "./codespace-workspace.js";
import {
  codespaceGetSchema,
  CODESPACE_ACTIONS,
  CODESPACE_ACTION_REQUEST_SCHEMAS,
  type CodespaceAction,
} from "./tool-schemas.js";

/**
 * Log context for the one codespace tool. The operation a call performs is its `action`, so that is
 * what the record names; an absent or non-string action reads as `unknown` rather than being
 * guessed, because the log is written before the action is validated.
 */
export function codespaceToolLogContext(params: unknown): {
  inputData: { codespace_action: string };
  resourceIds: Record<string, string>;
} {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const resourceIds: Record<string, string> = {};
  const codespaceId = codespaceGetSchema.shape.codespace_id.safeParse(record.codespace_id);
  const requestId = z
    .union([codespaceGetSchema.shape.codespace_id, z.string().regex(WORKSPACE_REQUEST_ID_PATTERN)])
    .safeParse(record.request_id);
  if (codespaceId.success) resourceIds.codespaceId = codespaceId.data;
  if (requestId.success) resourceIds.requestId = requestId.data;
  const action = CODESPACE_ACTION_SCHEMA.safeParse(record.action);
  return { inputData: { codespace_action: action.success ? action.data : "unknown" }, resourceIds };
}

type CodespaceToolParams = {
  [Action in CodespaceAction]: z.infer<(typeof CODESPACE_ACTION_REQUEST_SCHEMAS)[Action]>;
};

/**
 * Strict per-action request contracts applied after the SDK validated the flat published object:
 * exactly one stdin form, and command collection carries only its original request identity.
 * The published object accepts every action's fields, so this is what
 * refuses a field belonging to a different action than the one requested.
 */
const CODESPACE_ACTION_SCHEMA = z.enum(CODESPACE_ACTIONS);

/**
 * Published input that matches no strict request form. The bounded detail names only schema
 * field paths and Zod's generic issue text, never the submitted values.
 */
export class CodespaceRequestInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid codespace request: ${detail}`);
    this.name = "CodespaceRequestInvalidError";
  }
}

const MAX_REPORTED_ISSUES = 8;

function describeRequestIssues(error: z.ZodError): string {
  // A union failure reports the branch that came closest so the agent sees the field it
  // actually forgot rather than every alternative form.
  const closest = (issues: z.ZodIssue[]): z.ZodIssue[] =>
    issues.flatMap((issue) =>
      issue.code === "invalid_union"
        ? closest(
            issue.unionErrors
              .map((branch) => branch.issues)
              .reduce((best, branch) => (branch.length < best.length ? branch : best)),
          )
        : [issue],
    );
  const issues = closest(error.issues);
  const described = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "request"}: ${issue.message}`,
    );
  if (issues.length > MAX_REPORTED_ISSUES) described.push("…");
  return described.join("; ");
}

/**
 * Narrow published codespace input to the exact request form of its action; rejects an unknown
 * action and any mixed or partial form. `action` selects the contract and is not part of it, so it
 * is removed before the action's own schema sees the request.
 */
export function parseCodespaceToolParams(params: unknown): CodespaceCall {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const action = CODESPACE_ACTION_SCHEMA.safeParse(record.action);
  if (!action.success) throw new CodespaceRequestInvalidError(describeRequestIssues(action.error));
  const { action: _selected, ...request } = record;
  const parsed = CODESPACE_ACTION_REQUEST_SCHEMAS[action.data].safeParse(request);
  if (!parsed.success) throw new CodespaceRequestInvalidError(describeRequestIssues(parsed.error));
  return { action: action.data, request: parsed.data } as CodespaceCall;
}

export interface CodespaceToolServices {
  localRepositoryCreation?: {
    createRepository: (
      userId: string,
      input: {
        deviceId: string;
        requestId: string;
        repositoryName: string;
        installationId: string;
      },
    ) => Promise<unknown>;
  };
  localRepositories?: {
    listDevices: (userId: string) => unknown;
    addExistingRepository: (
      userId: string,
      input: { deviceId: string; repositoryId: string; requestId: string },
    ) => Promise<unknown>;
  };
  github?: {
    createOwnedPullRequest: (
      userId: string,
      resourceId: string,
      input: { head: string; base: string; title: string; body?: string; draft?: boolean },
    ) => Promise<unknown>;
    getOwnedPullRequest: (userId: string, resourceId: string, number: number) => Promise<unknown>;
    findOwnedPullRequests: (
      userId: string,
      resourceId: string,
      input: { head: string; base: string },
    ) => Promise<unknown>;
  };
  provider?: string;
  providers?: CodespaceToolServices[];
  select?: (
    userId: string,
    input: { repositoryId?: string; codespaceId?: string },
  ) => CodespaceToolServices;
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  observability: Pick<CodespaceObservabilityService, "readiness" | "limitsWithBilling">;
  guidance: (situation: CodespaceGuidanceSituation) => {
    provider: string;
    situation: CodespaceGuidanceSituation;
    instruction: string | null;
    links: CodespaceProviderGuidance["links"];
  };
  resource: Pick<
    CodespaceResourceService,
    | "listRepositories"
    | "setupSituation"
    | "listResources"
    | "refreshProviderState"
    | "getCodespace"
    | "create"
    | "startCodespace"
    | "stopCodespace"
    | "deleteCodespace"
    | "waitForState"
  > | null;
  workspace: WorkspaceToolClient;
  attachments?: WorkspaceAttachments;
}

const PROVIDER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "CODESPACE_AUTHORIZATION_REQUIRED",
  "CODESPACE_PROVIDER_UNAVAILABLE",
  "CODESPACE_RESOURCE_INVALID",
]);

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  LOCAL_DEVICE_REQUIRED:
    "Connect Moira Local in Settings and approve the pairing on your computer.",
  CONNECTION_REQUIRED: "Connect GitHub in Moira Settings before using cloud codespaces.",
  INSTALLATION_REQUIRED: "Complete the GitHub App installation in Moira Settings.",
  REPOSITORY_NOT_ALLOWED: "The repository is not approved for this connection.",
  CODESPACE_NOT_CONFIGURED: "Cloud codespaces are not configured on this Moira instance.",
  AUTH_REFRESH_FAILED: "GitHub authorization must be repaired in Moira Settings.",
  AUTH_GRANT_REVOCATION_REQUIRED: "Revoke and reconnect the GitHub grant in Moira Settings.",
  CREDENTIAL_UNREADABLE: "Restore or reconnect the GitHub credential in Moira Settings.",
  AUTHORIZATION_FAILED: "GitHub authorization could not be used.",
  CODESPACE_PROVIDER_DISABLED: "Codespace operations are disabled.",
  CODESPACE_PROVIDER_UNAVAILABLE: "The codespace provider is unavailable.",
  CODESPACE_POLICY_LIMIT: "A provider resource policy limit was reached.",
  CODESPACE_AUTHORIZATION_REQUIRED: "Restore codespace repository access in Moira Settings.",
  CODESPACE_CREATE_REJECTED: "Codespace creation was rejected.",
  CODESPACE_BILLING_UNSUPPORTED:
    "GitHub would bill an organization for this repository; Moira supports only personally billed Codespaces.",
  CODESPACE_CREATE_PENDING: "Codespace creation or cleanup is still pending.",
  CODESPACE_NOT_RUNNING: "The codespace is not ready and running.",
  CODESPACE_START_TIMEOUT:
    "The codespace was started for this call but is still starting; retry the same call shortly.",
  CODESPACE_GENERATION_CONFLICT: "Codespace access or state changed while this call was running.",
  CODESPACE_RESOURCE_INVALID: "The codespace input or current authorization is invalid.",
  CODESPACE_REQUEST_INVALID: "The request does not match the tool's input schema.",
  CODESPACE_NOT_FOUND: "Codespace was not found.",
  INTERNAL_ERROR: "The codespace operation failed safely.",
};

const SETUP_ERROR_CODES = new Set([
  "LOCAL_DEVICE_REQUIRED",
  "CONNECTION_REQUIRED",
  "INSTALLATION_REQUIRED",
  "CODESPACE_NOT_CONFIGURED",
  "AUTH_REFRESH_FAILED",
  "AUTH_GRANT_REVOCATION_REQUIRED",
  "CREDENTIAL_UNREADABLE",
  "AUTHORIZATION_FAILED",
  "REPOSITORY_NOT_ALLOWED",
  "CODESPACE_AUTHORIZATION_REQUIRED",
]);

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function retainedOutcomeError(response: CallToolResult, codespaceId?: string): CallToolResult {
  if (!codespaceId) return response;
  return {
    ...jsonResult({
      ...(response.structuredContent as Record<string, unknown>),
      ...(codespaceId ? { codespace_id: codespaceId } : {}),
    }),
    isError: true,
  };
}

const repositoryAdmissionResultSchema = z.object({
  status: z.enum(["pending", "applied", "unknown", "setup_required", "rejected"]),
  request_id: z.string().uuid(),
  local_repository_id: z.string().nullable(),
  full_name: z.string().nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  instruction: z.string().optional(),
  links: z.object({ settings: z.string(), installation: z.string().nullable() }).optional(),
});

/** Repeat only the same durable admission request; its service never repeats GitHub creation. */
async function completedRepositoryAdmission(read: () => Promise<unknown>): Promise<CallToolResult> {
  const deadline = Date.now() + LOCAL_WORKER_REQUEST_TIMEOUT_MS + 120_000;
  for (;;) {
    const result = repositoryAdmissionResultSchema.parse(await read());
    if (result.status === "applied" && result.local_repository_id) {
      return jsonResult({
        repository_id: result.local_repository_id,
        ...(result.full_name ? { name: result.full_name } : {}),
      });
    }
    if (result.status !== "pending" || Date.now() >= deadline) {
      const error = result.error ?? {
        code: "LOCAL_ADMISSION_UNCONFIRMED",
        message:
          result.instruction ??
          "The computer has not confirmed repository access. Recover this same request without creating another repository.",
      };
      return {
        ...jsonResult({
          error: {
            code: error.code,
            message: error.message,
            ...(result.links?.settings ? { settings_url: result.links.settings } : {}),
          },
          request_id: result.request_id,
        }),
        isError: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Codes whose refusal a user can act on, and which therefore carry the provider's links. */
const GUIDED_ERROR_CODES: ReadonlySet<string> = new Set([
  ...SETUP_ERROR_CODES,
  "CODESPACE_PROVIDER_DISABLED",
  "CODESPACE_POLICY_LIMIT",
]);

export function errorResult(
  code: string,
  settingsUrl?: string,
  retryable = false,
  detail?: string,
  links: CodespaceProviderGuidance["links"] = [],
): CallToolResult {
  const safeMessage =
    localCodespaceFailureGuidance(code)?.message ??
    SAFE_ERROR_MESSAGES[code] ??
    SAFE_ERROR_MESSAGES.INTERNAL_ERROR;
  // A refusal the user can act on carries the same destinations the guidance action returns, so an
  // agent never has to compose a link or send the user hunting for the right page.
  const guided = GUIDED_ERROR_CODES.has(code) ? links : [];
  const error = {
    code,
    message: detail ? `${safeMessage} ${detail}` : safeMessage,
    retryable,
    ...(settingsUrl && SETUP_ERROR_CODES.has(code) ? { settings_url: settingsUrl } : {}),
    ...(guided.length > 0
      ? { links: guided.map((link) => ({ id: link.id, url: link.url, label: link.label })) }
      : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error },
    isError: true,
  };
}

function projectCodespace(codespace: CodespaceResourceRecord): Record<string, unknown> {
  const summary = projectCodespaceSummary(codespace);
  const failure = summary.lifecycle_error;
  return {
    codespace_id: codespace.id,
    repository: codespace.repositoryFullName,
    ref: codespace.observedRef ?? codespace.requestedRef,
    state: codespace.state,
    ...(failure
      ? {
          error: {
            code: failure,
            message:
              localCodespaceFailureGuidance(failure)?.message ??
              SAFE_ERROR_MESSAGES[failure] ??
              SAFE_ERROR_MESSAGES.INTERNAL_ERROR,
          },
        }
      : {}),
  };
}

async function loadServices(): Promise<CodespaceToolServices> {
  const services = await import("@mcp-moira/web-backend/services");
  const providers = services.getCodespaceProviderBundles();
  const github = services.getLocalGitHubDeliveryService();
  const preferred =
    providers.find((provider) => provider.provider === "github-codespaces" && provider.resource) ??
    providers.find((provider) => provider.resource)!;
  return {
    ...preferred,
    providers,
    github,
    workspace: services.getWorkspaceClient(),
    attachments: {
      fetcher: services.getCodespaceNativeReferenceFetcher(),
      publisher: services.getCodespaceTransferService(),
    },
    localRepositories: services.getLocalRepositoryAdmissionService(),
    localRepositoryCreation: services.getLocalPrivateRepositoryCreationService(),
    select: services.selectCodespaceProviderServices,
  };
}

type CodespaceToolServicesLoader = () => Promise<CodespaceToolServices>;
let codespaceToolServicesLoader: CodespaceToolServicesLoader = loadServices;

export function getCodespaceToolServices(): Promise<CodespaceToolServices> {
  return codespaceToolServicesLoader();
}

export function setCodespaceToolServicesLoaderForTests(
  loader: CodespaceToolServicesLoader,
): () => void {
  const previous = codespaceToolServicesLoader;
  codespaceToolServicesLoader = loader;
  return () => {
    if (codespaceToolServicesLoader === loader) codespaceToolServicesLoader = previous;
  };
}

const logger = createLogger({ component: "ManageCodespaces" });

// Unexpected failures must stay diagnosable server-side. The request context already carries
// the requested action and opaque codespace/operation IDs; no agent input is added here.
type CodespaceToolFailureReporter = (action: CodespaceAction, error: unknown) => void;
let reportUnexpectedFailure: CodespaceToolFailureReporter = (action, error) => {
  logger.error("Codespace tool failed unexpectedly", error, { codespace_action: action });
};

export function setCodespaceToolFailureReporterForTests(
  reporter: CodespaceToolFailureReporter,
): () => void {
  const previous = reportUnexpectedFailure;
  reportUnexpectedFailure = reporter;
  return () => {
    if (reportUnexpectedFailure === reporter) reportUnexpectedFailure = previous;
  };
}

function requireReady(
  status: ReturnType<CodespaceConnectionService["getStatus"]>,
  guidanceLinks: CodespaceProviderGuidance["links"],
): { settingsUrl: string } | CallToolResult {
  if (status.state !== "connected") {
    const authorizationCode = [
      "AUTH_REFRESH_FAILED",
      "AUTH_GRANT_REVOCATION_REQUIRED",
      "CREDENTIAL_UNREADABLE",
      "AUTHORIZATION_FAILED",
    ].includes(status.reason ?? "")
      ? status.reason!
      : "AUTH_REFRESH_FAILED";
    const code =
      status.reason === "LOCAL_DEVICE_REQUIRED"
        ? "LOCAL_DEVICE_REQUIRED"
        : status.state === "installation_required"
          ? "INSTALLATION_REQUIRED"
          : status.state === "refresh_failed" || status.state === "revocation_pending"
            ? authorizationCode
            : status.state === "disabled" || status.state === "configuration_error"
              ? "CODESPACE_NOT_CONFIGURED"
              : "CONNECTION_REQUIRED";
    return errorResult(code, status.settingsUrl, true, undefined, guidanceLinks);
  }
  return { settingsUrl: status.settingsUrl };
}

function isErrorResult(value: { settingsUrl: string } | CallToolResult): value is CallToolResult {
  return "content" in value;
}

/** One validated call: the action requested, and the request its own contract accepted. */
export type CodespaceCall = {
  [Action in CodespaceAction]: { action: Action; request: CodespaceToolParams[Action] };
}[CodespaceAction];

export async function executeCodespaceTool(
  call: CodespaceCall,
  userId: string,
  services: CodespaceToolServices,
): Promise<CallToolResult> {
  const { action } = call;
  const params = call.request as CodespaceToolParams[CodespaceAction];
  // Admission is device-scoped, before repository-provider selection: its GitHub ID is not yet
  // an approved local repository ID. Only owner-applied delegation can grant that authority.
  if (action === "local_devices" || action === "repository_add" || action === "repository_create") {
    try {
      if (action === "repository_create") {
        if (!services.localRepositoryCreation) return errorResult("CODESPACE_NOT_CONFIGURED");
        const input = params as CodespaceToolParams["repository_create"];
        return await completedRepositoryAdmission(() =>
          services.localRepositoryCreation!.createRepository(userId, {
            deviceId: input.device_id,
            requestId: input.request_id,
            repositoryName: input.repository_name,
            installationId: input.installation_id,
          }),
        );
      }
      if (!services.localRepositories) return errorResult("CODESPACE_NOT_CONFIGURED");
      if (action === "local_devices") {
        const discovery = (await services.localRepositories.listDevices(userId)) as {
          devices: Array<{ device_id: string; label?: string; status?: string; enabled?: boolean }>;
          installations?: Array<{ installation_id: string; owner: string }>;
          github_setup_required?: boolean;
        };
        return jsonResult({
          devices: discovery.devices.map((device) => ({
            device_id: device.device_id,
            ...(device.label !== undefined ? { label: device.label } : {}),
            ...(device.status !== undefined ? { status: device.status } : {}),
            ...(device.enabled !== undefined ? { enabled: device.enabled } : {}),
          })),
          ...(discovery.installations
            ? {
                installations: discovery.installations.map(({ installation_id, owner }) => ({
                  installation_id,
                  owner,
                })),
              }
            : {}),
          ...(discovery.github_setup_required
            ? { warning: "Connect GitHub in Moira Settings before managing repositories." }
            : {}),
        });
      }
      const input = params as CodespaceToolParams["repository_add"];
      return await completedRepositoryAdmission(() =>
        services.localRepositories!.addExistingRepository(userId, {
          deviceId: input.device_id,
          repositoryId: input.repository_id,
          requestId: input.request_id,
        }),
      );
    } catch (error) {
      if (error instanceof LocalDeviceError) {
        return {
          ...jsonResult({ error: { code: error.code, message: error.message } }),
          isError: true,
        };
      }
      if (error instanceof CodespaceConnectionError || error instanceof CodespaceResourceError) {
        return errorResult(error.code);
      }
      reportUnexpectedFailure(action, error);
      return errorResult("INTERNAL_ERROR");
    }
  }
  if (
    action === "setup_help" &&
    services.providers &&
    !("repository_id" in params && params.repository_id)
  ) {
    try {
      services =
        services.providers.find(
          (provider) => provider.connection.getStatus(userId).state === "connected",
        ) ?? services;
    } catch (error) {
      reportUnexpectedFailure(action, error);
      return errorResult("INTERNAL_ERROR");
    }
  }
  if ((action === "list" || action === "repositories") && services.providers) {
    const results = await Promise.all(
      services.providers.map(async (provider) => ({
        provider: provider.provider,
        result: await executeCodespaceTool(call, userId, provider),
      })),
    );
    const successful = results.filter(
      (entry) => !entry.result.isError && entry.result.structuredContent,
    );
    if (successful.length === 0) return results[0].result;
    const projections: Array<Record<string, unknown> & { provider: string | undefined }> =
      successful.map((entry) => ({
        ...(entry.result.structuredContent as Record<string, unknown>),
        provider: entry.provider,
      }));
    const key = action === "list" ? "codespaces" : "repositories";
    return jsonResult({
      [key]: projections.flatMap((entry) => (entry[key] ?? []) as unknown[]),
      ...(projections.some((entry) => entry.warning)
        ? {
            warning:
              "Some provider data could not be refreshed; the last confirmed entries are shown.",
          }
        : {}),
    });
  }
  if (services.select && ("repository_id" in params || "codespace_id" in params)) {
    try {
      const github = services.github;
      const attachments = services.attachments;
      services = {
        ...services.select(userId, {
          ...("repository_id" in params ? { repositoryId: params.repository_id } : {}),
          ...("codespace_id" in params ? { codespaceId: params.codespace_id } : {}),
        }),
        github,
        attachments,
      };
    } catch (error) {
      if (error instanceof CodespaceResourceError) return errorResult(error.code);
      reportUnexpectedFailure(action, error);
      return errorResult("INTERNAL_ERROR");
    }
  }
  let status: ReturnType<CodespaceConnectionService["getStatus"]>;
  try {
    status = services.connection.getStatus(userId);
  } catch (error) {
    reportUnexpectedFailure(action, error);
    return errorResult("INTERNAL_ERROR");
  }
  let guidanceLinks: CodespaceProviderGuidance["links"] = [];
  let acceptedCodespaceId: string | undefined;
  try {
    // The provider's destinations, read once: a refusal the user can act on carries the same set the
    // guidance action returns, so the two can never disagree.
    guidanceLinks = services.guidance("ready").links;
    if (action === "list" || action === "repositories") {
      // The stored grants are a snapshot. Refresh it before answering, bounded by age, so a repository
      // the user added after connecting is not invisible until they reconnect; when the provider
      // cannot be reached the stored list is still the answer, and it says so rather than failing.
      const listInput = params as CodespaceToolParams["list"];
      const grants = await services.connection.refreshGrants(userId, {
        force: listInput.refresh === true,
      });
      const resources =
        action === "list" && listInput.refresh === true && !grants.stale && services.resource
          ? await services.resource.refreshProviderState(userId, { authorizationFresh: true })
          : { stale: listInput.refresh === true && grants.stale };
      status = services.connection.getStatus(userId);
      return jsonResult({
        ...(action === "repositories"
          ? {
              repositories:
                services.resource?.listRepositories(userId).map((repository) => ({
                  repository_id: repository.id,
                  name: repository.fullName,
                  private: repository.private,
                })) ?? [],
            }
          : { codespaces: services.resource?.listResources(userId).map(projectCodespace) ?? [] }),
        ...(grants.stale || resources.stale
          ? {
              warning:
                "The provider could not refresh this view; the last confirmed entries are shown.",
            }
          : {}),
      });
    }

    if (action === "setup_help") {
      // What the user must do next and where. Moira knows the situation; the provider supplies the
      // words and the links, so the agent repeats a checkable instruction instead of inventing one.
      const grants = await services.connection.refreshGrants(userId);
      status = services.connection.getStatus(userId);
      const instance = await services.observability.readiness();
      const input = params as CodespaceToolParams["setup_help"];
      const situation: CodespaceGuidanceSituation = !services.resource
        ? "not_configured"
        : instance.state === "disabled" || instance.state === "control_disabled"
          ? "instance_disabled"
          : status.state === "connected"
            ? services.resource.setupSituation(userId, input.repository_id)
            : status.reason === "INSTALLATION_REQUIRED"
              ? "installation_required"
              : status.state === "refresh_failed" || status.state === "revocation_pending"
                ? "authorization_repair_required"
                : "connection_required";
      const guidance = services.guidance(situation);
      return jsonResult({
        situation: guidance.situation,
        provider: guidance.provider,
        reason: status.reason,
        instruction: guidance.instruction,
        repositories_stale: grants.stale,
        links: guidance.links.map((link) => ({ id: link.id, url: link.url, label: link.label })),
      });
    }

    if (action === "get") {
      if (!services.resource)
        return errorResult(
          "CODESPACE_NOT_CONFIGURED",
          status.settingsUrl,
          false,
          undefined,
          guidanceLinks,
        );
      const input = params as CodespaceToolParams["get"];
      return jsonResult(
        projectCodespace(services.resource.getCodespace(userId, input.codespace_id)),
      );
    }

    if (action === "create") {
      await services.connection.refreshGrants(userId);
      status = services.connection.getStatus(userId);
    }

    const ready = requireReady(status, guidanceLinks);
    if (isErrorResult(ready)) return ready;
    if (!services.resource) {
      return errorResult(
        "CODESPACE_NOT_CONFIGURED",
        ready.settingsUrl,
        false,
        undefined,
        guidanceLinks,
      );
    }

    if (
      [
        "exec",
        "stat",
        "search",
        "read",
        "write",
        "apply_patch",
        "upload",
        "download",
        "preview_image",
      ].includes(action)
    ) {
      return await executeWorkspaceAction(call, userId, services.workspace, {
        attachments: services.attachments,
      });
    }

    switch (action) {
      case "pull_request_create": {
        const { codespace_id, ...input } = params as CodespaceToolParams["pull_request_create"];
        if (!services.github) return errorResult("CODESPACE_NOT_CONFIGURED", status.settingsUrl);
        return jsonResult({
          pull_request: await services.github.createOwnedPullRequest(userId, codespace_id, input),
        });
      }
      case "pull_request_get": {
        const input = params as CodespaceToolParams["pull_request_get"];
        if (!services.github) return errorResult("CODESPACE_NOT_CONFIGURED", status.settingsUrl);
        return jsonResult({
          pull_request: await services.github.getOwnedPullRequest(
            userId,
            input.codespace_id,
            input.pull_request_number,
          ),
        });
      }
      case "pull_request_find": {
        const { codespace_id, ...input } = params as CodespaceToolParams["pull_request_find"];
        if (!services.github) return errorResult("CODESPACE_NOT_CONFIGURED", status.settingsUrl);
        return jsonResult({
          pull_requests: await services.github.findOwnedPullRequests(userId, codespace_id, input),
        });
      }
      case "create": {
        const input = params as CodespaceToolParams["create"];
        const created = await services.resource.create(userId, input.repository_id, input.ref);
        acceptedCodespaceId = created.resource.id;
        return jsonResult(
          projectCodespace(
            await services.resource.waitForState(userId, created.resource.id, "usable"),
          ),
        );
      }
      case "start": {
        const input = params as CodespaceToolParams["start"];
        await services.resource.startCodespace(userId, input.codespace_id);
        acceptedCodespaceId = input.codespace_id;
        return jsonResult(
          projectCodespace(
            await services.resource.waitForState(userId, input.codespace_id, "usable"),
          ),
        );
      }
      case "stop": {
        const input = params as CodespaceToolParams["stop"];
        await services.resource.stopCodespace(userId, input.codespace_id);
        acceptedCodespaceId = input.codespace_id;
        return jsonResult(
          projectCodespace(
            await services.resource.waitForState(userId, input.codespace_id, "stopped"),
          ),
        );
      }
      case "delete": {
        const input = params as CodespaceToolParams["delete"];
        const current = services.resource.getCodespace(userId, input.codespace_id);
        await services.resource.deleteCodespace(userId, input.codespace_id, current.generation);
        acceptedCodespaceId = input.codespace_id;
        return jsonResult(
          projectCodespace(
            await services.resource.waitForState(userId, input.codespace_id, "deleted"),
          ),
        );
      }
    }
    // `list` and `get` answered above, before the readiness gate; the compiler knows they cannot
    // reach this switch, which is why they are not cases of it.
    return errorResult("CODESPACE_REQUEST_INVALID");
  } catch (error) {
    if (error instanceof LocalDeviceError)
      return retainedOutcomeError(
        {
          ...jsonResult({
            error: { code: error.code, message: error.message, settings_url: status.settingsUrl },
          }),
          isError: true,
        },
        acceptedCodespaceId,
      );
    if (error instanceof CodespaceConnectionError || error instanceof CodespaceResourceError) {
      recordCodespaceRejection(error.code);
      if (PROVIDER_REFUSAL_CODES.has(error.code)) {
        // The bounded internal message names only the provider's HTTP status; operators need
        // it to tell a permission gap from an outage, while the agent sees the safe code.
        logger.warn("Codespace provider refused the request", {
          codespace_action: action,
          code: error.code,
          detail: error.message,
        });
      }
      return retainedOutcomeError(
        errorResult(
          error.code,
          SETUP_ERROR_CODES.has(error.code) ? status.settingsUrl : undefined,
          [
            "CODESPACE_PROVIDER_UNAVAILABLE",
            "CODESPACE_POLICY_LIMIT",
            "CODESPACE_CREATE_PENDING",
            "CODESPACE_NOT_RUNNING",
          ].includes(error.code),
          // Only the refusing code decides what the caller may be told; the boundary forwards the
          // bounded detail it already declared safe and never derives one from the error code.
          error instanceof CodespaceResourceError ? error.detail : undefined,
          guidanceLinks,
        ),
        acceptedCodespaceId,
      );
    }
    reportUnexpectedFailure(action, error);
    return retainedOutcomeError(errorResult("INTERNAL_ERROR"), acceptedCodespaceId);
  }
}

export async function manageCodespaceTool(params: unknown): Promise<CallToolResult> {
  const { userId } = getUserContext();
  let parsed: ReturnType<typeof parseCodespaceToolParams>;
  try {
    parsed = parseCodespaceToolParams(params);
  } catch (error) {
    if (error instanceof CodespaceRequestInvalidError) {
      recordCodespaceRejection("CODESPACE_REQUEST_INVALID");
      return errorResult("CODESPACE_REQUEST_INVALID", undefined, false, error.detail);
    }
    throw error;
  }
  return executeCodespaceTool(parsed, userId, await codespaceToolServicesLoader());
}
