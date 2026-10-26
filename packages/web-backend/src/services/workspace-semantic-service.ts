import { z } from "zod";
import {
  WORKSPACE_TOOL_SCHEMAS,
  type WorkspaceToolName,
} from "@mcp-moira/shared/workspace-tool-schemas";
import { operationState } from "@mcp-moira/shared/workspace-operation-state";
import {
  CodespaceResourceError,
  ScopedCredentialError,
  scopedCredentialFailureOutcome,
  providerFailureSchema,
  LocalDeviceError,
  parseLocalRepositoryTargetId,
  localRepositoryTargetId,
  repositoryAdmissionProof,
  createWorkspaceRequestId,
  canonicalJson,
  codespaceObservationErrorCode,
  controllerOperationSchema,
  controllerWorkspaceResolutionSchema,
  type CodespaceSummaryView,
  type CodespaceUnavailableResourceView,
  type CodespaceDiscoveryView,
  type LocalDeviceService,
} from "@mcp-moira/shared";
import {
  decodeReference,
  encodeReference,
  isReference,
  isOwnerSelector,
  type OwnerSelector,
  type ControllerReference,
  type OperationKind,
} from "@mcp-moira/shared/workspace-references";
import {
  getCodespaceProviderBundles,
  selectCodespaceProviderServices,
  getLocalDeviceService,
  type CodespaceProviderServices,
} from "./codespace-services.js";
import { getWorkspaceClient, getControllerClient } from "./workspace-client.js";
import type { WorkspaceClient } from "./workspace-router.js";
import { getLocalRepositoryAdmissionService } from "./local-repository-admission-factory.js";
import { getLocalPrivateRepositoryCreationService } from "./local-private-repository-creation-factory.js";
import { LocalCodespaceResourceService } from "./local-codespace-resource-service.js";
import { CodespaceEffectObservationError } from "./codespace-effect-observation-error.js";

type Input = Record<string, unknown>;
export interface ResolvedWorkspace {
  workspace: WorkspaceClient;
  resourceId: string;
  owner: Exclude<OwnerSelector, { kind: "controller" }>;
}
export interface ResolvedController {
  controller: WorkspaceClient;
  deviceId: string;
  owner: Extract<OwnerSelector, { kind: "controller" }>;
}
export interface WorkspaceSemanticDependencies {
  providers: CodespaceProviderServices[];
  select: typeof selectCodespaceProviderServices;
  devices: LocalDeviceService;
  workspace: WorkspaceClient;
  controller: WorkspaceClient;
  repositories: ReturnType<typeof getLocalRepositoryAdmissionService>;
  repositoryCreation: ReturnType<typeof getLocalPrivateRepositoryCreationService>;
}
const discoveryCursorSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a returned discovery cursor" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .object({
        controller: z.string().nullable(),
        repositories: z.string().nullable(),
      })
      .strict(),
  );
function invalid(message: string): never {
  throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", message);
}
function unavailable(message: string): never {
  throw new CodespaceResourceError("CODESPACE_PROVIDER_UNAVAILABLE", message);
}

/** Semantic projection and current-authority resolution; never an effect/result journal. */
export function createWorkspaceSemanticServices(dependencies: WorkspaceSemanticDependencies) {
  const { devices } = dependencies;
  const controllerIdentity = (userId: string, deviceId: string): ControllerReference => {
    const current = devices.getDeviceIdentity(userId, deviceId);
    return { deviceId: current.deviceId, connectionId: current.connectionId };
  };
  const authorizeController = (userId: string, selected: ControllerReference) => {
    devices.repository.getActiveDevice(userId, selected.deviceId);
    const current = controllerIdentity(userId, selected.deviceId);
    if (current.connectionId !== selected.connectionId)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "The selected computer connection changed.");
    return current;
  };
  const checkedControllerRead = async (
    userId: string,
    selected: ControllerReference,
    path: string,
    body: unknown,
  ) => {
    authorizeController(userId, selected);
    const before = devices.getDeviceIdentity(userId, selected.deviceId);
    const result = await dependencies.controller.json(userId, selected.deviceId, {
      method: "POST",
      path,
      body,
    });
    if (
      canonicalJson(devices.getDeviceIdentity(userId, selected.deviceId)) !== canonicalJson(before)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Computer authority changed during observation.",
      );
    authorizeController(userId, selected);
    return result;
  };
  const resolveLocal = async (
    userId: string,
    deviceId: string,
    selector: { resourceId: string } | { spaceId: string; operationMarker: string },
  ): Promise<ResolvedWorkspace> => {
    const selected = controllerIdentity(userId, deviceId);
    const retained = controllerWorkspaceResolutionSchema.parse(
      await checkedControllerRead(userId, selected, "/v1/controller/workspaces/resolve", {
        deviceId,
        ...selector,
      }),
    );
    if (
      ("resourceId" in selector && retained.resourceId !== selector.resourceId) ||
      ("spaceId" in selector &&
        (retained.localSpaceId !== selector.spaceId ||
          retained.operationMarker !== selector.operationMarker))
    )
      invalid("The computer returned a different environment binding.");
    const provider = dependencies.select(userId, { codespaceId: retained.resourceId });
    const binding = devices.getBinding(userId, retained.resourceId);
    if (
      provider.provider !== "local-sandboxes" ||
      !binding ||
      binding.deviceId !== deviceId ||
      binding.connectionId !== selected.connectionId ||
      binding.repositoryId !== retained.repositoryId
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "The original environment has no current route binding.",
      );
    return {
      workspace: dependencies.workspace,
      resourceId: retained.resourceId,
      owner: {
        kind: "local",
        deviceId,
        spaceId: retained.localSpaceId,
        operationMarker: retained.operationMarker,
      },
    };
  };
  const resolveWorkspaceResource = async (
    userId: string,
    resourceId: string,
  ): Promise<ResolvedWorkspace> => {
    const selected = dependencies.select(userId, { codespaceId: resourceId });
    if (selected.provider === "github-codespaces")
      return {
        workspace: dependencies.workspace,
        resourceId,
        owner: { kind: "github", resourceId },
      };
    const binding = devices.getBinding(userId, resourceId);
    if (!binding) unavailable("The original environment has no current computer binding.");
    return resolveLocal(userId, binding.deviceId, { resourceId });
  };
  const resolveWorkspace = async (
    userId: string,
    reference: string | OwnerSelector,
  ): Promise<ResolvedWorkspace> => {
    if (typeof reference === "string") {
      const captured = decodeReference(reference, "workspace");
      const selected = dependencies.select(userId, { codespaceId: captured.resourceId });
      if (selected.provider !== captured.provider)
        invalid("Environment provider does not match the reference.");
      const resolved = await resolveWorkspaceResource(userId, captured.resourceId);
      if (
        captured.deviceId &&
        resolved.owner.kind === "local" &&
        resolved.owner.deviceId !== captured.deviceId
      )
        invalid("Environment owner does not match the reference.");
      return resolved;
    }
    if (!isOwnerSelector(reference) || reference.kind === "controller")
      invalid("A workspace owner is required.");
    return reference.kind === "local"
      ? resolveLocal(userId, reference.deviceId, {
          spaceId: reference.spaceId,
          operationMarker: reference.operationMarker,
        })
      : resolveWorkspaceResource(userId, reference.resourceId);
  };
  const resolveOwner = async (
    userId: string,
    owner: OwnerSelector,
  ): Promise<ResolvedWorkspace | ResolvedController> => {
    if (!isOwnerSelector(owner)) invalid("The original owner reference is invalid.");
    if (owner.kind !== "controller") return resolveWorkspace(userId, owner);
    authorizeController(userId, owner);
    return { controller: dependencies.controller, deviceId: owner.deviceId, owner };
  };
  const operationReference = (
    owner: OwnerSelector,
    requestId: string,
    kind: OperationKind,
    journal?: "repository-create",
  ) => encodeReference("operation", { owner, requestId, kind, ...(journal ? { journal } : {}) });
  const controllerOwner = (
    userId: string,
    deviceId: string,
  ): Extract<OwnerSelector, { kind: "controller" }> => ({
    kind: "controller",
    ...controllerIdentity(userId, deviceId),
  });
  const project = (userId: string, view: CodespaceSummaryView) => {
    const deviceId =
      view.device_id ??
      (view.provider === "local-sandboxes"
        ? parseLocalRepositoryTargetId(view.repository_id).deviceId
        : undefined);
    const { codespace_id, generation, pending_request_ids } = view;
    return {
      provider: view.provider,
      repository_id: view.repository_id,
      repository: view.repository,
      requested_ref: view.requested_ref,
      current_ref: view.current_ref,
      ref: view.current_ref ?? view.requested_ref,
      machine: view.machine
        ? {
            name: view.machine.name,
            display_name: view.machine.display_name,
            operating_system: view.machine.operating_system,
            cpu_cores: view.machine.cpu_cores,
            memory_bytes: view.machine.memory_bytes,
            storage_bytes: view.machine.storage_bytes,
          }
        : null,
      state: view.state,
      retention_policy: view.retention_policy,
      desired_state: view.desired_state,
      observed_state: view.observed_state,
      observed_at: view.observed_at,
      lifecycle_error: view.lifecycle_error,
      created_at: view.created_at,
      updated_at: view.updated_at,
      ...(view.remote ? { remote: { state: view.remote.state } } : {}),
      ...(view.setup_failure ? { setup_failure: view.setup_failure } : {}),
      workspace: encodeReference("workspace", {
        resourceId: codespace_id,
        provider: view.provider as "local-sandboxes" | "github-codespaces",
        ...(deviceId ? { deviceId } : {}),
        generation,
      }),
      pending_operations: deviceId
        ? (pending_request_ids ?? []).map((requestId) =>
            operationReference(controllerOwner(userId, deviceId), requestId, "unknown"),
          )
        : [],
    };
  };
  const projectUnavailable = (userId: string, view: CodespaceUnavailableResourceView) => {
    const { codespace_id, pending_request_ids, device_id } = view;
    return {
      provider: view.provider,
      repository_id: view.repository_id,
      repository: view.repository,
      requested_ref: view.requested_ref,
      created_at: view.created_at,
      error: { code: view.error.code },
      identity: encodeReference("workspace-identity", {
        resourceId: codespace_id,
        provider: view.provider as "local-sandboxes" | "github-codespaces",
        ...(device_id ? { deviceId: device_id } : {}),
      }),
      pending_operations: device_id
        ? (pending_request_ids ?? []).map((requestId) =>
            operationReference(controllerOwner(userId, device_id), requestId, "unknown"),
          )
        : [],
    };
  };
  type RepositoryResult =
    | Awaited<ReturnType<WorkspaceSemanticDependencies["repositories"]["addExistingRepository"]>>
    | Awaited<ReturnType<WorkspaceSemanticDependencies["repositoryCreation"]["createRepository"]>>;
  const projectRepository = (result: RepositoryResult, controller: ControllerReference) => {
    const instruction =
      result.status === "applied"
        ? "Use the returned target with workspace_create and the chosen branch."
        : result.status === "rejected"
          ? "Inspect this original refusal before deciding on another repository operation. If the repository was already created, repair its access in Moira Settings without creating a replacement."
          : "Restore the selected GitHub and computer permissions in Moira Settings, then inspect this original operation. A retained private-repository setup can be continued explicitly with operation_resume; an absent record cannot be resumed.";
    return {
      status: result.status,
      instruction,
      ...(result.error
        ? {
            error: {
              code: result.error.code,
              message: instruction,
              ...("stage" in result.error && result.error.stage
                ? { stage: result.error.stage }
                : {}),
              ...("provider_status" in result.error && result.error.provider_status !== undefined
                ? { provider_status: result.error.provider_status }
                : {}),
            },
          }
        : {}),
      ...("full_name" in result
        ? {
            repository: result.full_name,
            github_repository_id: result.github_repository_id,
            links: result.links,
          }
        : {}),
      ...(result.local_repository_id
        ? {
            target: encodeReference("target", {
              provider: "local-sandboxes",
              repositoryId: result.local_repository_id,
              controller,
            }),
          }
        : {}),
    };
  };
  const effect = async (
    userId: string,
    owner: OwnerSelector,
    requestId: string,
    kind: OperationKind,
    action: () => Promise<unknown>,
    journal?: "repository-create",
  ) => {
    const operation = operationReference(owner, requestId, kind, journal);
    try {
      const result = await action();
      if (owner.kind === "controller") authorizeController(userId, owner);
      const observed = result && typeof result === "object" ? (result as Input) : {};
      if (observed.status === "rejected")
        return {
          operation,
          kind,
          description: "Original owner operation",
          state: "completed",
          outcome: {
            ok: false,
            error: observed.error ?? {
              code: "LOCAL_REPOSITORY_REJECTED",
              message: "The original repository request was refused.",
            },
          },
        };
      const state = ["unknown", "ambiguous", "unconfirmed"].includes(
        String(observed.status ?? observed.state),
      )
        ? "unconfirmed"
        : [
              "pending",
              "setup_required",
              "create_pending",
              "start_pending",
              "stop_pending",
              "delete_pending",
            ].includes(String(observed.status ?? observed.state))
          ? "pending"
          : "completed";
      return {
        operation,
        kind,
        description: "Original owner operation",
        state,
        ...(state === "completed" ? { outcome: { ok: true, result } } : { original: result }),
      };
    } catch (error) {
      // A private completed effect never substitutes for current permission to disclose it.
      // A refusal here escapes this catch rather than becoming an observation diagnostic.
      if (owner.kind === "controller") authorizeController(userId, owner);
      if (error instanceof CodespaceEffectObservationError)
        return {
          operation,
          kind,
          description: "Original owner operation",
          state: "completed",
          outcome: { ok: true, result: null },
          observation_error: { code: error.code },
        };
      const known =
        error instanceof CodespaceResourceError ||
        error instanceof LocalDeviceError ||
        error instanceof ScopedCredentialError;
      const code = known ? error.code : "WORKSPACE_OUTCOME_UNCONFIRMED";
      const confirmedProviderRefusal =
        error instanceof CodespaceResourceError && error.confirmedRefusal;
      const scopedOutcome =
        error instanceof ScopedCredentialError ? scopedCredentialFailureOutcome(error.code) : null;
      const uncertain =
        !known ||
        (!confirmedProviderRefusal &&
          scopedOutcome !== "refused" &&
          ![
            "CODESPACE_RESOURCE_INVALID",
            "CODESPACE_GENERATION_CONFLICT",
            "CODESPACE_NOT_FOUND",
            "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
            "CODESPACE_LOCAL_SETUP_INCOMPLETE",
            "LOCAL_INVALID",
          ].includes(code));
      const detail = error instanceof CodespaceResourceError ? error.detail : undefined;
      const providerFailure =
        error instanceof CodespaceResourceError
          ? providerFailureSchema.safeParse(error.providerFailure)
          : null;
      const errorView = {
        code,
        message: [
          uncertain
            ? "Collect this original operation before choosing another action."
            : "The owner refused this operation.",
          detail,
        ]
          .filter(Boolean)
          .join(" "),
        ...(providerFailure?.success ? { provider_failure: providerFailure.data } : {}),
      };
      return {
        operation,
        kind,
        description: "Original owner operation",
        state: uncertain ? "unconfirmed" : "completed",
        ...(uncertain
          ? { original: { error: errorView } }
          : { outcome: { ok: false, error: errorView } }),
      };
    }
  };
  const controllerView = (
    reference: string,
    result: Awaited<ReturnType<LocalDeviceService["getOperation"]>>,
  ) => {
    const original = decodeReference(reference, "operation");
    const state = operationState(result);
    const phase = "phase" in result && result.phase ? { phase: result.phase } : {};
    return {
      operation: reference,
      kind: original.kind,
      description: "Original controller operation",
      state,
      ...(state === "completed"
        ? { outcome: result.outcome }
        : state === "absent"
          ? {}
          : { original: { ...phase, ...(result.outcome ? { outcome: result.outcome } : {}) } }),
    };
  };
  const collectedControllerView = async (
    userId: string,
    reference: string,
    result: Awaited<ReturnType<LocalDeviceService["getOperation"]>>,
  ) => {
    const view = controllerView(reference, result);
    const original = decodeReference(reference, "operation");
    if (
      view.state !== "completed" ||
      !result.outcome?.ok ||
      (original.kind !== "lifecycle" && original.kind !== "unknown")
    )
      return view;
    if (
      original.kind === "unknown" &&
      (!result.outcome.result ||
        typeof result.outcome.result !== "object" ||
        !("resourceId" in result.outcome.result))
    )
      return view;
    if (original.owner.kind !== "controller") invalid("The original owner is not a controller.");
    let captured: CodespaceSummaryView | undefined;
    let observationError: unknown;
    try {
      const { resourceId } = z
        .object({ resourceId: z.string().uuid() })
        .parse(result.outcome.result);
      const provider = dependencies.select(userId, { codespaceId: resourceId });
      if (!provider.resource) unavailable("The original resource projection is unavailable.");
      const snapshot = await provider.resource.projectRetainedSnapshot(
        userId,
        result.outcome.result,
      );
      if (snapshot.device_id !== original.owner.deviceId)
        invalid("The retained resource belongs to a different controller.");
      captured = snapshot;
    } catch (error) {
      // Collection already proved the effect. A missing historical projection is a
      // separate observation failure, never permission to resubmit that effect.
      observationError = error;
    }
    // Check current account/device authority on both projection paths, outside the
    // catch that preserves known effect completion for unavailable observations.
    authorizeController(userId, original.owner);
    return captured
      ? {
          ...view,
          kind: "lifecycle" as const,
          outcome: { ok: true, result: project(userId, captured) },
        }
      : {
          ...view,
          outcome: { ok: true, result: null },
          observation_error: { code: codespaceObservationErrorCode(observationError) },
        };
  };
  const invoke = async (
    userId: string,
    tool: string,
    input: Input,
    suppliedRequestId?: string,
    options?: { ownerConfirmed?: boolean },
  ): Promise<unknown> => {
    if (!Object.hasOwn(WORKSPACE_TOOL_SCHEMAS, tool))
      invalid("Choose a supported workspace purpose.");
    input = WORKSPACE_TOOL_SCHEMAS[tool as WorkspaceToolName].parse(input);
    if (tool === "workspace_list") {
      const provider = dependencies.providers.find((p) => p.provider === input.provider);
      if (!provider) unavailable("The selected workspace provider is unavailable.");
      try {
        if (!provider.resource)
          return { workspaces: [], unavailable: [], has_diagnostics: false, provider_errors: [] };
        const found = await provider.resource.listResources(userId, {
          view: input.view as CodespaceDiscoveryView | undefined,
        });
        return {
          workspaces: found.codespaces.map((v) => project(userId, v)),
          unavailable: found.unavailable.map((v) => projectUnavailable(userId, v)),
          has_diagnostics: found.has_diagnostics ?? found.unavailable.length > 0,
          provider_errors: [],
        };
      } catch (error) {
        return {
          workspaces: [],
          unavailable: [],
          has_diagnostics: false,
          error: {
            code: "CODESPACE_PROVIDER_UNAVAILABLE",
            message:
              "The selected provider observation is unavailable; original workspace identities remain retained.",
          },
          provider_errors: [
            { provider: provider.provider, error: { code: codespaceObservationErrorCode(error) } },
          ],
        };
      }
    }
    if (tool === "workspace_targets") {
      const provider = dependencies.providers.find((p) => p.provider === input.provider);
      if (!provider) unavailable("The selected repository provider is unavailable.");
      const observation =
        provider.provider === "local-sandboxes" ? devices.createObservation(userId) : undefined;
      const discovery = await dependencies.repositories.listDevices(userId, {
        includeInstallations: input.provider === "github-codespaces",
        observeDevices: input.provider === "local-sandboxes",
        ...(observation ? { observation } : {}),
      });
      const controllers = discovery.devices
        .filter((device) => device.status === "active")
        .map((device) => ({
          controller: encodeReference("controller", controllerIdentity(userId, device.device_id)),
          label: device.label,
          ...(observation ? { available: device.owner_available } : {}),
        }));
      try {
        if (!observation) await provider.connection.refreshGrants(userId);
        const repositories =
          provider.resource instanceof LocalCodespaceResourceService && observation
            ? await provider.resource.listRepositories(userId, { observation })
            : ((await provider.resource?.listRepositories(userId)) ?? []);
        return {
          targets: repositories.flatMap((repository) => {
            const selectedControllers =
              provider.provider === "local-sandboxes"
                ? [controllerIdentity(userId, parseLocalRepositoryTargetId(repository.id).deviceId)]
                : controllers.map((c) => decodeReference(c.controller, "controller"));
            return selectedControllers.map((controller) => ({
              target: encodeReference("target", {
                provider: provider.provider as "local-sandboxes" | "github-codespaces",
                repositoryId: repository.id,
                controller,
              }),
              repository: repository.fullName,
              private: repository.private,
            }));
          }),
          controllers,
          installations: discovery.installations.flatMap((installation) =>
            controllers.map((c) => ({
              installation: encodeReference("installation", {
                controller: decodeReference(c.controller, "controller"),
                installationId: installation.installation_id,
              }),
              owner: installation.owner,
              computer: c.label,
            })),
          ),
          provider_errors: [],
        };
      } catch (error) {
        return {
          targets: [],
          controllers,
          installations: [],
          provider_errors: [
            { provider: provider.provider, error: { code: codespaceObservationErrorCode(error) } },
          ],
          error: {
            code: "CODESPACE_PROVIDER_UNAVAILABLE",
            message: "The selected repository provider observation is unavailable.",
          },
        };
      }
    }
    if (tool === "workspace_setup_help") {
      const target = input.target ? decodeReference(String(input.target), "target") : undefined;
      return dependencies.providers
        .filter((p) => !target || p.provider === target.provider)
        .map((p) => {
          const status = p.connection.getStatus(userId);
          const situation =
            status.state === "connected"
              ? "ready"
              : status.state === "installation_required"
                ? "installation_required"
                : status.state === "disabled" || status.state === "configuration_error"
                  ? "not_configured"
                  : "connection_required";
          return { ...p.guidance(situation), settings_url: status.settingsUrl };
        });
    }
    if (tool === "workspace_observe") {
      const ref = String(input.workspace);
      const selected = isReference(ref, "workspace")
        ? decodeReference(ref, "workspace")
        : decodeReference(ref, "workspace-identity");
      const provider = dependencies.select(userId, { codespaceId: selected.resourceId });
      if (provider.provider !== selected.provider || !provider.resource)
        invalid("The environment reference has no matching provider.");
      return project(userId, await provider.resource.getCodespace(userId, selected.resourceId));
    }
    if (tool === "operation_get") {
      const original = decodeReference(String(input.reference), "operation");
      if (original.owner.kind !== "controller")
        invalid("Workspace receipts are collected at their original guest owner.");
      authorizeController(userId, original.owner);
      if (original.journal === "repository-create") {
        const retained = dependencies.repositoryCreation.inspectOriginal(
          userId,
          original.owner.deviceId,
          original.owner.connectionId,
          original.requestId,
        );
        const record = dependencies.repositoryCreation.getSavedAdmission(
          userId,
          original.owner.deviceId,
          original.owner.connectionId,
          original.requestId,
        );
        if (!record || retained.state === "absent")
          return { operation: input.reference, kind: "repository", state: "absent" };
        const base = {
          operation: input.reference,
          kind: "repository",
          description: retained.descriptor.description,
        };
        if (record.state === "rejected")
          return {
            ...base,
            state: "completed",
            outcome: {
              ok: false,
              error: retained.error ?? {
                code: "LOCAL_REPOSITORY_CREATE_REJECTED",
                message: "The original repository creation was refused.",
              },
            },
          };
        if (record.state !== "created" || record.installationVerified !== 1)
          return { ...base, state: retained.state, original: retained.result };
        const admission = await devices.getOperation(
          userId,
          original.owner.deviceId,
          `ws1-${record.admissionRequestId}`,
        );
        authorizeController(userId, original.owner);
        if (admission.state !== "completed" || !admission.outcome?.ok)
          return {
            ...base,
            state:
              admission.state === "unconfirmed" || admission.outcome?.ok === false
                ? "unconfirmed"
                : "pending",
            original: {
              creation: retained.result,
              admission: controllerView(
                operationReference(
                  original.owner,
                  `ws1-${record.admissionRequestId}`,
                  "repository",
                ),
                admission,
              ),
            },
          };
        let proof: ReturnType<typeof repositoryAdmissionProof>;
        try {
          proof = repositoryAdmissionProof(admission.outcome.result, {
            userId,
            deviceId: original.owner.deviceId,
            connectionId: original.owner.connectionId,
            deviceGeneration: record.deviceGeneration,
            requestId: record.admissionRequestId,
            creationRequestId: record.requestId,
            githubRepositoryId: record.repositoryId!,
          });
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof LocalDeviceError)) throw error;
          return {
            ...base,
            state: "unconfirmed",
            original: {
              creation: retained.result,
              error: {
                code: "LOCAL_ADMISSION_UNCONFIRMED",
                message:
                  "The retained child receipt does not prove this original repository admission; no action was retried.",
              },
            },
          };
        }
        const repositoryId = localRepositoryTargetId(
          original.owner.deviceId,
          proof.receipt.localRepositoryId,
        );
        return {
          ...base,
          state: "completed",
          outcome: {
            ok: true,
            result: {
              status: "applied",
              repository: record.fullName,
              target: encodeReference("target", {
                provider: "local-sandboxes",
                repositoryId,
                controller: {
                  deviceId: original.owner.deviceId,
                  connectionId: original.owner.connectionId,
                },
              }),
            },
          },
        };
      }
      const result = await devices.getOperation(
        userId,
        original.owner.deviceId,
        original.kind === "repository" && !original.requestId.startsWith("ws1-")
          ? `ws1-${original.requestId}`
          : original.requestId,
      );
      return collectedControllerView(userId, String(input.reference), result);
    }
    if (tool === "operation_resume") {
      const reference = String(input.reference);
      const original = decodeReference(reference, "operation");
      if (
        original.owner.kind !== "controller" ||
        original.kind !== "repository" ||
        original.journal !== "repository-create"
      )
        invalid("Only an original retained private-repository creation can be resumed.");
      authorizeController(userId, original.owner);
      const record = dependencies.repositoryCreation.getSavedAdmission(
        userId,
        original.owner.deviceId,
        original.owner.connectionId,
        original.requestId,
      );
      const collected = (await invoke(userId, "operation_get", { reference })) as Input;
      if (!record || collected.state === "completed" || collected.state === "absent")
        return collected;
      const selected = {
        deviceId: original.owner.deviceId,
        connectionId: original.owner.connectionId,
      };
      return effect(
        userId,
        original.owner,
        original.requestId,
        "repository",
        async () => {
          authorizeController(userId, selected);
          const result = await dependencies.repositoryCreation.createRepository(userId, {
            deviceId: record.deviceId,
            requestId: record.requestId,
            repositoryName: record.repositoryName,
            installationId: record.installationId,
          });
          authorizeController(userId, selected);
          return projectRepository(result, selected);
        },
        "repository-create",
      );
    }
    if (tool === "operation_find") {
      const selected = decodeReference(String(input.owner), "controller");
      authorizeController(userId, selected);
      const cursor = input.cursor ? discoveryCursorSchema.parse(input.cursor) : undefined;
      const result =
        cursor?.controller === null
          ? { operations: [] }
          : await checkedControllerRead(userId, selected, "/v1/controller/operations/find", {
              ...(input.kind ? { kind: input.kind } : {}),
              ...(input.query ? { query: input.query } : {}),
              ...(cursor?.controller ? { cursor: cursor.controller } : {}),
            });
      const owner = { kind: "controller" as const, ...selected };
      const repositories =
        cursor?.repositories === null || (input.kind && input.kind !== "repository")
          ? { operations: [], nextCursor: undefined }
          : dependencies.repositoryCreation.findOriginals(
              userId,
              selected.deviceId,
              selected.connectionId,
              cursor?.repositories ?? undefined,
            );
      const operations = z
        .array(
          z
            .object({
              requestId: z.string(),
              state: z.string(),
              descriptor: z
                .object({ kind: z.string(), description: z.string().optional() })
                .passthrough()
                .optional(),
              outcome: controllerOperationSchema.shape.outcome,
            })
            .passthrough(),
        )
        .parse(result.operations)
        .map((v) => ({
          state: operationState(v),
          ...(v.descriptor ? { descriptor: v.descriptor } : {}),
          operation: operationReference(
            owner,
            v.requestId,
            (v.descriptor?.kind ?? "unknown") as OperationKind,
          ),
        }));
      const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
      const repositoryOperations = repositories.operations
        .filter((v) => v.descriptor?.description.toLowerCase().includes(query))
        .map(({ requestId, ...v }) => ({
          ...v,
          operation: operationReference(owner, requestId, "repository", "repository-create"),
        }));
      const next = {
        controller:
          "nextCursor" in result && typeof result.nextCursor === "string"
            ? result.nextCursor
            : null,
        repositories: repositories.nextCursor ?? null,
      };
      return {
        operations: [...operations, ...repositoryOperations],
        ...(next.controller || next.repositories
          ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") }
          : {}),
      };
    }
    if (tool === "workspace_create") {
      const target = decodeReference(String(input.target), "target");
      if (!target.controller) invalid("Select a repository target with its computer owner.");
      authorizeController(userId, target.controller);
      const provider = dependencies.select(userId, { repositoryId: target.repositoryId });
      if (!provider.resource || provider.provider !== target.provider)
        invalid("The repository target has no matching provider.");
      const requestId = suppliedRequestId ?? createWorkspaceRequestId();
      return effect(
        userId,
        { kind: "controller", ...target.controller },
        requestId,
        "lifecycle",
        async () =>
          project(
            userId,
            await provider.resource!.create(
              userId,
              target.repositoryId,
              String(input.branch),
              requestId,
              target.provider === "github-codespaces"
                ? {
                    deviceId: target.controller!.deviceId,
                    ...(input.devcontainer_path
                      ? { devcontainerPath: String(input.devcontainer_path) }
                      : {}),
                  }
                : undefined,
            ),
          ),
      );
    }
    if (
      tool === "workspace_lifecycle" ||
      tool === "workspace_delete" ||
      tool === "workspace_adopt"
    ) {
      const selected = decodeReference(String(input.workspace), "workspace");
      const provider = dependencies.select(userId, { codespaceId: selected.resourceId });
      if (!provider.resource || provider.provider !== selected.provider)
        invalid("The environment reference has no matching provider.");
      const controller =
        tool === "workspace_adopt"
          ? decodeReference(String(input.controller), "controller")
          : selected.deviceId
            ? controllerIdentity(userId, selected.deviceId)
            : undefined;
      if (!controller) invalid("The environment reference has no assigned owner.");
      authorizeController(userId, controller);
      const owner = { kind: "controller" as const, ...controller };
      const resource = provider.resource;
      const requestId = suppliedRequestId ?? createWorkspaceRequestId();
      return effect(userId, owner, requestId, "lifecycle", async () => {
        if (tool === "workspace_adopt") {
          if (!("adopt" in resource))
            invalid("Adoption applies to an existing GitHub environment.");
          return project(
            userId,
            await resource.adopt(userId, selected.resourceId, requestId, selected.generation, {
              deviceId: controller.deviceId,
            }),
          );
        } else if (tool === "workspace_delete") {
          if (input.confirm_delete !== true) invalid("Deletion requires explicit confirmation.");
          return project(
            userId,
            await resource.deleteCodespace(userId, selected.resourceId, selected.generation, {
              requestId,
              ...(options?.ownerConfirmed ? { ownerConfirmed: true } : {}),
            }),
          );
        } else
          switch (input.action) {
            case "start":
              return project(
                userId,
                await resource.startCodespace(
                  userId,
                  selected.resourceId,
                  requestId,
                  selected.generation,
                ),
              );
            case "stop":
              return project(
                userId,
                await resource.stopCodespace(
                  userId,
                  selected.resourceId,
                  requestId,
                  selected.generation,
                ),
              );
            case "resume_setup":
              if (!("resumeSetup" in resource))
                invalid("Setup resume requires an environment with a retained preparation proof.");
              return project(
                userId,
                await resource.resumeSetup(
                  userId,
                  selected.resourceId,
                  requestId,
                  selected.generation,
                ),
              );
            default:
              invalid("Choose a supported lifecycle action.");
          }
      });
    }
    if (tool === "repository_admit" || tool === "repository_create") {
      const selected = decodeReference(String(input.controller), "controller");
      authorizeController(userId, selected);
      const requestId = (suppliedRequestId ?? createWorkspaceRequestId()).replace(/^ws1-/, "");
      return effect(
        userId,
        { kind: "controller", ...selected },
        requestId,
        "repository",
        async () => {
          const result =
            tool === "repository_admit"
              ? await dependencies.repositories.addExistingRepository(userId, {
                  deviceId: selected.deviceId,
                  repositoryId: String(input.repository),
                  requestId,
                })
              : await (async () => {
                  const installation = decodeReference(String(input.installation), "installation");
                  if (canonicalJson(installation.controller) !== canonicalJson(selected))
                    invalid("Installation belongs to another selected computer.");
                  return dependencies.repositoryCreation.createRepository(userId, {
                    deviceId: selected.deviceId,
                    requestId,
                    repositoryName: String(input.name),
                    installationId: String(installation.installationId),
                  });
                })();
          return projectRepository(result, selected);
        },
        tool === "repository_create" ? "repository-create" : undefined,
      );
    }
    if (tool === "workspace_adopt_external") {
      const selected = decodeReference(String(input.controller), "controller");
      authorizeController(userId, selected);
      const resource = dependencies.providers.find(
        (p) => p.provider === "github-codespaces",
      )?.resource;
      if (!resource || !("registerExisting" in resource) || !("adopt" in resource))
        unavailable("GitHub environment adoption is unavailable.");
      const requestId = suppliedRequestId ?? createWorkspaceRequestId();
      return effect(
        userId,
        { kind: "controller", ...selected },
        requestId,
        "lifecycle",
        async () => {
          const registered = await resource.registerExisting(userId, String(input.name), {
            requestId,
            deviceId: selected.deviceId,
          });
          return project(
            userId,
            await resource.adopt(
              userId,
              registered.codespace_id,
              requestId,
              registered.generation,
              {
                deviceId: selected.deviceId,
              },
            ),
          );
        },
      );
    }
    invalid("This purpose is not a controller operation.");
  };
  return {
    invoke,
    resolveWorkspace,
    resolveOwner,
    resolveWorkspaceResource,
    project,
    projectUnavailable,
    controllerIdentity,
  };
}
let services: ReturnType<typeof createWorkspaceSemanticServices> | undefined;
export function getWorkspaceSemanticServices() {
  return (services ??= createWorkspaceSemanticServices({
    providers: getCodespaceProviderBundles(),
    select: selectCodespaceProviderServices,
    devices: getLocalDeviceService(),
    workspace: getWorkspaceClient(),
    controller: getControllerClient(),
    repositories: getLocalRepositoryAdmissionService(),
    repositoryCreation: getLocalPrivateRepositoryCreationService(),
  }));
}
