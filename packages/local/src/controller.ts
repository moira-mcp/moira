import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { chmod, lstat, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as waitForObservation } from "node:timers/promises";
import { z } from "zod";
import {
  controllerIdentitySchema,
  controllerRequestIdSchema,
  controllerOperationFindSchema,
  controllerOperationFindResultSchema,
  controllerWorkspaceResolveSchema,
  controllerLifecycleSchema,
  controllerSettingsSchema,
  controllerRepositorySchema,
  controllerGitHubLifecycleSchema,
  githubControllerResourceSchema,
  githubCreatePreflightSchema,
  githubMachineOffersSchema,
  githubPreparedCreateSchema,
  githubProvisionProofSchema,
  providerFailureSchema,
  providerObservationSchema,
  providerReplySchema,
  type GitHubControllerResource,
  type GitHubProvisionProof,
  type ControllerGitHubLifecycle,
  type ControllerIdentity,
  type ControllerLifecycle,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import {
  assertAgentRepositoryAdmission,
  localDeviceControlViewSchema,
  localRepositoryAdmissionReceiptSchema,
} from "../../shared/src/codespaces/local-management-types.js";
import { LocalManager } from "./manager.js";
import { LocalRelay } from "./relay.js";
import { ControllerState, type ControllerBinding } from "./controller-state.js";
import { canonicalJson } from "../../shared/src/utils/canonical-json.js";
import { CODESPACE_IDLE_TIMEOUT_MINUTES } from "../../shared/src/codespaces/resource-types.js";
import { workspaceRemoteObservationSchema } from "../../shared/src/codespaces/local-protocol.js";
import { LocalWebControl, controlSettings } from "./web-control.js";
import { LocalRefusal, requireLocalGrant, publicPolicy } from "./policy.js";
import {
  provisionGitHubWorkspace,
  resumeGitHubWorkspaceEnrollment,
  githubProvisioningReadiness,
  type GitHubReadinessPurpose,
} from "./github-provisioner.js";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.js";
import { localConnectionSchema, relayOrigin } from "./relay.js";
import { createOwnerPublications } from "../../workspace-service/src/publications.mjs";
import {
  createOwnerCommunication,
  findOwnerCommunication,
} from "../../workspace-service/src/owner-communication.mjs";
import { createOwnerCommunicationTransport } from "../../workspace-service/src/communication-transport.mjs";
import {
  readOwnerFrame,
  settleOwnerFrame,
  OWNER_STREAM_CONTENT_TYPE,
} from "@mcp-moira/shared/http/owner-stream-frame";
import { communicationOwnerSubmitSchema } from "../../shared/src/communication-owner-protocol.js";
import { deliverOwnerExtension as deliverExtension } from "../../workspace-service/src/extension-owner.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const identityKeys = ["userId", "deviceId", "deviceGeneration", "connectionId"] as const;
const headerKeys = [
  "x-moira-user-id",
  "x-moira-device-id",
  "x-moira-device-generation",
  "x-moira-connection-id",
] as const;

/** Physical operations and their durable result belong to this device, not its live channel. */
export class LocalController {
  private communicationOwner?: Promise<{
    delivery: Awaited<ReturnType<typeof createOwnerCommunication>>;
    publications: Awaited<ReturnType<typeof createOwnerPublications>>;
  }>;
  async communication() {
    this.requireAdmission();
    return (this.communicationOwner ??= (async () => {
      const connection = await this.manager.records.state.read(
        "connection.json",
        localConnectionSchema.parse,
      );
      if (
        !connection ||
        connection.authorityRefused ||
        connection.userId !== this.identity.userId ||
        connection.deviceId !== this.identity.deviceId ||
        connection.deviceGeneration !== this.identity.deviceGeneration ||
        connection.connectionId !== this.identity.connectionId
      )
        throw new LocalRefusal(
          "LOCAL_UNAUTHORIZED",
          "Current paired communication authority is unavailable.",
        );
      const scope = { kind: "controller" as const, ...this.identity };
      const origin = relayOrigin(connection.origin);
      const stateRoot = join(this.manager.records.state.root, "controller-files");
      let commitTail: Promise<unknown> = Promise.resolve();
      // The manager's existing runner gate owns this private namespace across processes.
      const publications = await createOwnerPublications({
        stateRoot,
        scope: { ...scope, publicOrigin: origin },
        environmentIdentity: JSON.stringify(this.identity),
        withCommitLock: (work) => {
          const next = commitTail.catch(() => undefined).then(work);
          commitTail = next;
          return next;
        },
      });
      const transport = createOwnerCommunicationTransport({
        origin,
        credential: connection.credential,
      });
      const runtime = fileURLToPath(
        new URL(
          /\/src\/controller\.(?:ts|js)$/.test(new URL(import.meta.url).pathname)
            ? "../dist/owner-runtime/"
            : "owner-runtime/",
          import.meta.url,
        ),
      );
      const delivery = await createOwnerCommunication({
        stateRoot,
        scope,
        publications,
        transport,
        deliverExtension,
        extensionArtifact: transport.artifact,
        handlerHost: join(runtime, "extension-handler-host.mjs"),
        extensionHelperPath: fileURLToPath(
          new URL(
            /\/src\/controller\.(?:ts|js)$/.test(new URL(import.meta.url).pathname)
              ? "../dist/process-group-helper"
              : "process-group-helper",
            import.meta.url,
          ),
        ),
        admit: (requestId, inputDigest, work) =>
          this.state.run(
            requestId,
            this.identity,
            { action: "communication", inputDigest },
            async () => {
              const receipt = await work();
              if (receipt.outcome?.ok === false)
                throw new LocalRefusal(receipt.outcome.error.code, receipt.outcome.error.message);
              return receipt.outcome?.ok === true ? receipt.outcome.result : receipt;
            },
          ),
        renderProgress: async (descriptor, options) => {
          const module = await import(pathToFileURL(join(runtime, "owner-renderer.mjs")).href);
          return module.renderOwnerProgress(descriptor, options);
        },
        renderMaterialize: async (files, options) => {
          const module = await import(pathToFileURL(join(runtime, "owner-renderer.mjs")).href);
          return module.renderOwnerMaterialize(files, options);
        },
      });
      return { delivery, publications };
    })().catch((error) => {
      this.communicationOwner = undefined;
      throw error;
    }));
  }
  async closeCommunication() {
    if (this.communicationOwner) {
      const owner = await this.communicationOwner;
      await owner.delivery.close();
      await owner.publications.close();
    }
  }
  readonly state: ControllerState;
  readonly control: LocalWebControl;
  private settingsTail: Promise<unknown> = Promise.resolve();
  private resourceTails = new Map<string, Promise<unknown>>();
  private readonly physicalClosures = new Set<Promise<unknown>>();
  private retiring = false;
  private githubEffects = new Map<
    string,
    {
      requestId: string;
      abort: AbortController;
      settled: Promise<unknown>;
      custodyUnconfirmed: boolean;
    }
  >();
  private resourceLane<T>(resourceId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.resourceTails.get(resourceId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.resourceTails.set(resourceId, next);
    void next
      .finally(() => {
        if (this.resourceTails.get(resourceId) === next) this.resourceTails.delete(resourceId);
      })
      .catch(() => undefined);
    return next;
  }
  private settingsLane<T>(work: () => Promise<T>): Promise<T> {
    const next = this.settingsTail
      .catch(() => undefined)
      .then(async () => {
        // Every path acquires physical ownership before settings exclusion.
        // Admission may itself convert private settings under that same gate.
        await this.manager.holdRunnerLock();
        return this.manager.records.withSettingsChange(work);
      });
    this.settingsTail = next;
    return next;
  }
  constructor(
    readonly manager: LocalManager,
    readonly identity: ControllerIdentity,
    control = new LocalWebControl(manager.records),
    private readonly registerResource: LocalRelay["registerResource"] = (input) =>
      new LocalRelay(manager.records).registerResource(input),
    private readonly github: {
      relay: LocalRelay;
      provision: typeof provisionGitHubWorkspace;
      resume?: typeof resumeGitHubWorkspaceEnrollment;
      readiness: typeof githubProvisioningReadiness;
    } = {
      relay: new LocalRelay(manager.records),
      provision: provisionGitHubWorkspace,
      readiness: githubProvisioningReadiness,
      resume: resumeGitHubWorkspaceEnrollment,
    },
  ) {
    this.identity = controllerIdentitySchema.parse(identity);
    this.state = new ControllerState(manager.records);
    this.control = control;
  }
  async initialize(): Promise<void> {
    await this.manager.holdRunnerLock();
    await this.state.importBindings(this.identity);
  }
  authorize(request: IncomingMessage): boolean {
    if (!headerKeys.some((key) => request.headers[key] !== undefined)) return true;
    const values = Object.fromEntries(
      identityKeys.map((key, index) => [
        key,
        key === "deviceGeneration"
          ? Number(request.headers[headerKeys[index]])
          : request.headers[headerKeys[index]],
      ]),
    );
    const current = controllerIdentitySchema.parse(values);
    if (!identityKeys.every((key) => current[key] === this.identity[key]))
      throw new LocalRefusal(
        "LOCAL_UNAUTHORIZED",
        "Controller request belongs to another paired owner.",
      );
    return false;
  }
  async snapshot(completingRequestId?: string, resourceId?: string) {
    const metadata = await this.managementSnapshot(completingRequestId);
    if (metadata.local.state !== "configured") return { ...metadata, local: metadata.local };
    return {
      ...metadata,
      local: { ...metadata.local, ...(await this.localResources(resourceId)) },
      observedAt: Date.now(),
    };
  }
  /** Current control evidence never waits for physical runtime inventory. */
  async managementSnapshot(completingRequestId?: string) {
    if (!completingRequestId) this.requireAdmission();
    const configured = await this.manager.records.policyOrNull();
    const local = configured ? await this.localMetadata(completingRequestId) : undefined;
    const pending = await this.state.pendingResources(this.identity);
    return {
      version: 1,
      ...this.identity,
      ownerConnectionId: this.identity.connectionId,
      local: local
        ? {
            state: "configured" as const,
            policy: local.policy,
            control: local.control,
            observedAt: local.observedAt,
          }
        : { state: "unconfigured" as const },
      github: {
        resources: (await this.state.githubBindings(this.identity))
          .map((binding) => {
            const {
              userId: _user,
              deviceId: _device,
              deviceGeneration: _generation,
              connectionId: _connection,
              setupRequestId: _setupRequest,
              ...resource
            } = binding;
            return {
              ...resource,
              pendingRequestIds: (pending.get(resource.resourceId) ?? []).filter(
                (requestId) => requestId !== completingRequestId,
              ),
            };
          })
          .map((resource) => githubControllerResourceSchema.parse(resource)),
      },
      observedAt: Date.now(),
    };
  }

  /** A receipt address resolves through retained ownership, without native observation. */
  async resolveWorkspace(input: unknown) {
    this.requireAdmission();
    const selector = controllerWorkspaceResolveSchema.parse(input);
    if (selector.deviceId !== this.identity.deviceId)
      throw new LocalRefusal(
        "LOCAL_UNAUTHORIZED",
        "Workspace belongs to another selected controller.",
      );
    const assigned =
      "resourceId" in selector
        ? await this.state.binding(selector.resourceId, this.identity)
        : undefined;
    const spaceId = "spaceId" in selector ? selector.spaceId : assigned?.localSpaceId;
    const space = spaceId ? await this.manager.records.get(spaceId) : null;
    if (
      !space ||
      ("operationMarker" in selector && space.operationMarker !== selector.operationMarker)
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The retained workspace selector does not match.",
      );
    const binding = assigned ?? (await this.state.forSpace(space, this.identity));
    if (
      binding.localSpaceId !== space.id ||
      binding.operationMarker !== space.operationMarker ||
      binding.repositoryId !== space.repositoryId
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The current controller binding does not match its original space.",
      );
    return {
      resourceId: binding.resourceId,
      resourceGeneration: binding.resourceGeneration,
      routeGeneration: binding.routeGeneration ?? binding.resourceGeneration,
      repositoryId: binding.repositoryId,
      localSpaceId: binding.localSpaceId,
      localGeneration: binding.localGeneration,
      operationMarker: binding.operationMarker,
    };
  }

  async findOperations(input: unknown) {
    this.requireAdmission();
    const selection = controllerOperationFindSchema.parse(input);
    const [controller, communication] = await Promise.all([
      this.state.find(this.identity, selection),
      findOwnerCommunication(
        {
          stateRoot: join(this.manager.records.state.root, "controller-files"),
          scope: { kind: "controller", ...this.identity },
        },
        selection,
      ),
    ]);
    const operations = new Map(
      controller.operations.map((operation) => [operation.requestId, operation]),
    );
    for (const operation of communication.operations) {
      operations.set(operation.requestId, {
        requestId: operation.requestId,
        state: operation.state as "completed" | "unconfirmed",
        kind: operation.kind,
        ...(operation.createdAt === undefined
          ? {}
          : {
              descriptor: {
                kind: operation.kind,
                description: operation.description,
                createdAt: operation.createdAt,
              },
            }),
      });
    }
    const ordered = [...operations.values()].sort((a, b) => a.requestId.localeCompare(b.requestId));
    const page = ordered.slice(0, 50);
    return controllerOperationFindResultSchema.parse({
      operations: page,
      ...(page.length &&
      (ordered.length > page.length || controller.nextCursor || communication.nextCursor)
        ? { nextCursor: page[page.length - 1].requestId }
        : {}),
    });
  }
  /** Explicit physical shutdown retires provisioning; remote observation loss does not. */
  async stopProvisioning(): Promise<void> {
    const effects = [...this.githubEffects.values()];
    for (const effect of effects) effect.abort.abort();
    await Promise.allSettled(effects.map((effect) => effect.settled));
    if (effects.some((effect) => effect.custodyUnconfirmed))
      throw new LocalRefusal(
        "LOCAL_CUSTODY_UNCONFIRMED",
        "Provisioning process closure is unconfirmed; owner retirement remains fenced.",
      );
  }
  async retire(): Promise<void> {
    this.retiring = true;
    const results = await Promise.allSettled([
      this.stopProvisioning(),
      this.manager.stopWork(),
      this.closeCommunication(),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Owner retirement is not confirmed.",
      );
  }
  /** Freeze admission before a locally requested service maintenance boundary. */
  fenceAdmission(): void {
    this.retiring = true;
  }
  async prepareMaintenance(): Promise<void> {
    this.retiring = true;
    await this.stopProvisioning();
    // Native admission publishes its record before long guest preparation. Do not
    // wait for that work to finish before an explicitly requested interruption.
    await Promise.allSettled([this.settingsTail, ...this.resourceTails.values()]);
    // A previously admitted user stop/delete is intent, not work to resurrect.
    await Promise.allSettled([...this.physicalClosures]);
  }
  private requireAdmission(): void {
    if (this.retiring)
      throw new LocalRefusal(
        "LOCAL_CONTROLLER_STOPPING",
        "The physical owner is retiring; no new work is admitted.",
      );
  }
  async githubLifecycle(resourceId: string, input: unknown) {
    this.requireAdmission();
    z.string().uuid().parse(resourceId);
    const value = controllerGitHubLifecycleSchema.parse(input);
    if (value.action === "create" && value.requestId.slice(4) !== resourceId)
      throw new LocalRefusal(
        "LOCAL_REPLAY_CONFLICT",
        "Creation must retain its original resource identity.",
      );
    const original = await this.state.inspect(value.requestId, this.identity);
    if (original.state !== "absent")
      return this.state.run(value.requestId, this.identity, { resourceId, ...value }, async () => {
        throw new LocalRefusal("LOCAL_REPLAY_CONFLICT", "Original owner work cannot be replayed.");
      });
    if (value.action === "resume_setup") return this.resumeGitHubSetup(resourceId, value);
    let rebindPurpose: "adopt" | "retire" | undefined;
    if (value.action === "adopt") rebindPurpose = "adopt";
    else if (value.action === "delete") {
      try {
        await this.github.relay.githubAssignment(resourceId);
      } catch (error) {
        if (!(error instanceof LocalRefusal) || error.code !== "CODESPACE_AUTHORIZATION_REQUIRED")
          throw error;
        rebindPurpose = "retire";
      }
    }
    if (rebindPurpose) {
      const preview = await this.github.relay.githubAssignment(
        resourceId,
        undefined,
        rebindPurpose,
      );
      const prior = await this.state.githubBindingForAdoption(resourceId, this.identity);
      if (
        preview.resourceId !== resourceId ||
        (prior ? prior.resourceGeneration : preview.resourceGeneration) !==
          value.expectedGeneration ||
        (prior && preview.resourceGeneration > prior.resourceGeneration)
      )
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Explicit reauthorization requires the current observed owner generation.",
        );
      await this.drainGitHubForReauthorization(resourceId);
    }
    await this.requireGitHubCustodySettled(resourceId);
    if (["create", "start", "adopt"].includes(value.action)) await this.requireGitHubReadiness();
    return this.state.run(value.requestId, this.identity, { resourceId, ...value }, async () => {
      const admitted = await this.resourceLane(resourceId, async () => {
        this.requireAdmission();
        await this.requireGitHubCustodySettled(resourceId);
        let binding;
        let previousRepositoryFullName: string | undefined;
        if (rebindPurpose) {
          const assignment = await this.github.relay.githubAssignment(
            resourceId,
            undefined,
            rebindPurpose,
          );
          const prior = await this.state.githubBindingForAdoption(resourceId, this.identity);
          if (
            assignment.resourceId !== resourceId ||
            (prior &&
              (prior.resourceId !== resourceId ||
                prior.repositoryId !== assignment.repositoryId ||
                prior.operationMarker !== assignment.operationMarker ||
                (prior.providerResourceName !== null &&
                  prior.providerResourceName !== assignment.providerResourceName) ||
                assignment.resourceGeneration > prior.resourceGeneration))
          )
            throw new LocalRefusal(
              "LOCAL_IDENTITY_CHANGED",
              "Verified adoption assignment differs from its original resource and owner CAS.",
            );
          // Only explicit cloud reauthorization of this account/repository/device may
          // replace the old auth epoch and canonical repository name before admission.
          if (
            value.action === "adopt" &&
            prior &&
            prior.repositoryFullName !== assignment.repositoryFullName
          )
            previousRepositoryFullName = prior.repositoryFullName;
          if (value.action === "adopt" && prior && assignment.providerResourceName) {
            const observed = providerObservationSchema.safeParse(assignment.providerResource);
            if (
              observed.success &&
              observed.data.name === assignment.providerResourceName &&
              observed.data.repositoryId === prior.repositoryId &&
              observed.data.repositoryFullName === assignment.repositoryFullName
            ) {
              // Restored authorization supplies a fresh exact marker/owner proof.
              // Closing the prior creation receipt is observation only, before this
              // explicit adoption advances CAS or performs any provisioning.
              const pending = await this.state.pendingResources(this.identity);
              for (const originalId of pending.get(resourceId) ?? []) {
                const creation = await this.state.originalProviderCreation(
                  originalId,
                  this.identity,
                );
                if (
                  creation?.resourceId === resourceId &&
                  creation.resourceGeneration <= prior.resourceGeneration
                )
                  await this.state.settleObservedCreation(originalId, this.identity);
              }
            }
          }
          const {
            billableOwnerId: _payer,
            creationSettings: _settings,
            ...assignedResource
          } = assignment;
          await this.state.putGitHubBinding(
            {
              ...assignedResource,
              resourceGeneration: prior?.resourceGeneration ?? assignment.resourceGeneration,
            },
            this.identity,
          );
          binding = (await this.state.githubBinding(resourceId, this.identity))!;
        } else binding = await this.state.githubBinding(resourceId, this.identity);
        if (!binding) {
          const assignment = await this.github.relay.githubAssignment(resourceId);
          if (assignment.resourceId !== resourceId)
            throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Assigned resource identity changed.");
          if (
            value.action === "create" &&
            (assignment.repositoryId !== value.repositoryId ||
              assignment.repositoryFullName !== value.repositoryFullName ||
              assignment.requestedRef !== value.ref ||
              assignment.operationMarker !== value.operationMarker ||
              assignment.authorizationGeneration !== value.authorizationGeneration ||
              assignment.devcontainerPath !== value.devcontainerPath)
          )
            throw new LocalRefusal(
              "LOCAL_IDENTITY_CHANGED",
              "Creation differs from its verified assignment.",
            );
          const { billableOwnerId: _payer, creationSettings: _settings, ...resource } = assignment;
          await this.state.putGitHubBinding(resource, this.identity);
          binding = (await this.state.githubBinding(resourceId, this.identity))!;
        } else if (value.action === "create") {
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Another original creation already owns this resource.",
          );
        }
        if (binding.resourceGeneration !== value.expectedGeneration)
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "GitHub resource generation differs from the observed owner generation.",
          );
        if (binding.state === "deleted")
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "A retired GitHub resource cannot be reused.",
          );
        const previous = this.githubEffects.get(resourceId);
        previous?.abort.abort();
        const {
          userId: _user,
          deviceId: _device,
          deviceGeneration: _deviceGeneration,
          connectionId: _connection,
          setupRequestId: _setupRequest,
          ...resource
        } = binding;
        const preparing = ["create", "start", "adopt"].includes(value.action);
        const next: GitHubControllerResource & { setupRequestId?: string } = {
          ...githubControllerResourceSchema.parse({
            ...resource,
            ...(preparing ? { environmentIdentity: null, remote: undefined } : {}),
            resourceGeneration: binding.resourceGeneration + 1,
            desiredState:
              value.action === "delete"
                ? "deleted"
                : value.action === "stop"
                  ? "stopped"
                  : "running",
            state: value.action === "create" ? "creating" : "unknown",
            pendingRequestIds: [value.requestId],
          }),
          ...(!preparing && binding.setupRequestId
            ? { setupRequestId: binding.setupRequestId }
            : {}),
        };
        await this.state.putGitHubBinding(next, this.identity);
        const abort = new AbortController();
        let custodyUnconfirmed = false;
        const settled = Promise.resolve()
          .then(async () => {
            await previous?.settled.catch((error: unknown) => {
              if (
                previous.custodyUnconfirmed ||
                (error instanceof LocalRefusal && error.code === "LOCAL_CUSTODY_UNCONFIRMED")
              )
                throw error;
            });
            if (abort.signal.aborted)
              throw new LocalRefusal(
                "LOCAL_OPERATION_RETIRED",
                "A newer owner operation retired this provisioning work.",
              );
            if (["create", "start", "adopt"].includes(value.action))
              await this.requireGitHubReadiness();
            await this.github.relay.registerGitHubResource(
              resourceId,
              {
                requestId: value.requestId,
                resourceGeneration: next.resourceGeneration,
                authorizationGeneration: next.authorizationGeneration,
                providerResourceName: next.providerResourceName,
                retirement: next.retirement,
                ...(rebindPurpose ? { rebindPurpose } : {}),
              },
              abort.signal,
            );
            let observed: unknown;
            if (value.action === "create") {
              const assignment = await this.github.relay.githubAssignment(resourceId, abort.signal);
              if (
                assignment.resourceGeneration !== next.resourceGeneration ||
                assignment.authorizationGeneration !== next.authorizationGeneration ||
                assignment.repositoryId !== next.repositoryId ||
                assignment.repositoryFullName !== next.repositoryFullName ||
                assignment.requestedRef !== next.requestedRef ||
                assignment.operationMarker !== next.operationMarker ||
                assignment.devcontainerPath !== next.devcontainerPath
              )
                throw new LocalRefusal(
                  "LOCAL_IDENTITY_CHANGED",
                  "Creation assignment changed before preparation.",
                );
              const request = {
                requestId: value.requestId,
                resourceGeneration: next.resourceGeneration,
              };
              const preflight = githubCreatePreflightSchema.parse(
                await this.github.relay.githubProvider(
                  resourceId,
                  { ...request, action: "preflight" },
                  abort.signal,
                ),
              );
              if (preflight.billableOwnerId !== assignment.billableOwnerId)
                throw new LocalRefusal(
                  "CODESPACE_BILLING_UNSUPPORTED",
                  "Provider payer does not match the assigned account.",
                );
              const machines = githubMachineOffersSchema.parse(
                await this.github.relay.githubProvider(
                  resourceId,
                  { ...request, action: "machines" },
                  abort.signal,
                ),
              );
              if (!machines.length)
                throw new LocalRefusal(
                  "CODESPACE_RESOURCE_INVALID",
                  "Provider offers no machine for this ref.",
                );
              const prepared = githubPreparedCreateSchema.parse({
                machine: machines[0],
                idleTimeoutMinutes: assignment.creationSettings.autoStopEnabled
                  ? assignment.creationSettings.idleTimeoutMinutes
                  : CODESPACE_IDLE_TIMEOUT_MINUTES.maximum,
                retentionMinutes: assignment.creationSettings.retentionMinutes,
              });
              await this.state.recordGitHubPreparedCreate(value.requestId, this.identity, prepared);
              await this.state.recordPhase(value.requestId, this.identity, {
                name: "provider_create",
                resourceGeneration: next.resourceGeneration,
              });
              // Only the cloud broker can witness the provider POST. Crossing its
              // boundary is uncertain locally until its original reply is confirmed.
              next.retirement = "unknown";
              await this.settleGitHub(next, { retirement: "unknown" });
              const result = z
                .discriminatedUnion("outcome", [
                  z
                    .object({
                      outcome: z.literal("accepted"),
                      resource: providerObservationSchema.nullable(),
                      providerReply: providerReplySchema.optional(),
                    })
                    .strict(),
                  z
                    .object({
                      outcome: z.literal("rejected"),
                      reason: z.string(),
                      detail: z.string().optional(),
                      providerFailure: providerFailureSchema.optional(),
                    })
                    .strict(),
                ])
                .parse(
                  await this.github.relay.githubProvider(
                    resourceId,
                    {
                      requestId: value.requestId,
                      resourceGeneration: next.resourceGeneration,
                      action: "create",
                      prepared,
                    },
                    abort.signal,
                  ),
                );
              if (result.outcome === "rejected") {
                await this.settleGitHub(next, { retirement: "retired" });
                throw Object.assign(
                  new LocalRefusal(
                    "CODESPACE_CREATE_REJECTED",
                    "The provider refused this original creation.",
                  ),
                  result.providerFailure ? { providerFailure: result.providerFailure } : {},
                );
              }
              observed = result.resource;
            } else if (value.action !== "adopt") {
              if (
                !next.providerResourceName &&
                !(value.action === "delete" && next.retirement === "uncreated")
              ) {
                const discovered = providerObservationSchema.parse(
                  await this.github.relay.githubProvider(
                    resourceId,
                    {
                      requestId: value.requestId,
                      resourceGeneration: next.resourceGeneration,
                      action: "get",
                    },
                    abort.signal,
                  ),
                );
                if (
                  discovered.repositoryId !== next.repositoryId ||
                  discovered.repositoryFullName.toLowerCase() !==
                    next.repositoryFullName.toLowerCase()
                )
                  throw new LocalRefusal(
                    "LOCAL_IDENTITY_CHANGED",
                    "The original creation identity could not be confirmed.",
                  );
                next.providerResourceName = discovered.name;
                await this.github.relay.registerGitHubResource(
                  resourceId,
                  {
                    requestId: value.requestId,
                    resourceGeneration: next.resourceGeneration,
                    authorizationGeneration: next.authorizationGeneration,
                    providerResourceName: discovered.name,
                    retirement: "owned",
                  },
                  abort.signal,
                );
                await this.settleGitHub(next, { providerResourceName: discovered.name });
              }
              await this.state.recordPhase(value.requestId, this.identity, {
                name: `provider_${value.action}`,
                resourceGeneration: next.resourceGeneration,
              });
              observed = await this.github.relay.githubProvider(
                resourceId,
                {
                  requestId: value.requestId,
                  resourceGeneration: next.resourceGeneration,
                  action: value.action,
                },
                abort.signal,
              );
            } else {
              observed = await this.github.relay.githubProvider(
                resourceId,
                {
                  requestId: value.requestId,
                  resourceGeneration: next.resourceGeneration,
                  action: "get",
                },
                abort.signal,
              );
              if (observed && providerObservationSchema.parse(observed).state === "shutdown") {
                await this.state.recordPhase(value.requestId, this.identity, {
                  name: "provider_start",
                  resourceGeneration: next.resourceGeneration,
                });
                observed = await this.github.relay.githubProvider(
                  resourceId,
                  {
                    requestId: value.requestId,
                    resourceGeneration: next.resourceGeneration,
                    action: "start",
                  },
                  abort.signal,
                );
              }
            }
            // A provider acknowledgement is not an observation of physical state.
            // Non-create effects always collect their exact state through pure GET.
            if (value.action !== "create") observed = undefined;
            observed = await this.observeGitHub(
              next,
              value.requestId,
              value.action,
              observed,
              abort.signal,
            );
            if (value.action === "delete") {
              if (observed !== null)
                throw new LocalRefusal(
                  "WORKSPACE_OUTCOME_UNCONFIRMED",
                  "Deletion is not yet confirmed; collect the original operation.",
                );
              await this.github.relay.registerGitHubResource(
                resourceId,
                {
                  requestId: value.requestId,
                  resourceGeneration: next.resourceGeneration,
                  authorizationGeneration: next.authorizationGeneration,
                  providerResourceName: next.providerResourceName,
                  retirement: "retired",
                },
                abort.signal,
              );
              await this.settleGitHub(next, {
                state: "deleted",
                retirement: "retired",
                providerResource: null,
                environmentIdentity: null,
                pendingRequestIds: [],
                observedAt: Date.now(),
              });
              return this.githubResource(resourceId, value.requestId);
            }
            const exact = providerObservationSchema.parse(observed);
            if (
              exact.repositoryId !== next.repositoryId ||
              exact.repositoryFullName.toLowerCase() !== next.repositoryFullName.toLowerCase() ||
              (next.providerResourceName && exact.name !== next.providerResourceName)
            )
              throw new LocalRefusal(
                "LOCAL_IDENTITY_CHANGED",
                "Provider observation differs from the assigned repository and resource.",
              );
            next.providerResourceName = exact.name;
            await this.github.relay.registerGitHubResource(
              resourceId,
              {
                requestId: value.requestId,
                resourceGeneration: next.resourceGeneration,
                authorizationGeneration: next.authorizationGeneration,
                providerResourceName: exact.name,
                retirement: "owned",
              },
              abort.signal,
            );
            await this.settleGitHub(next, {
              providerResourceName: exact.name,
              retirement: "owned",
              providerResource: exact,
              observedAt: Date.now(),
            });
            if (value.action === "stop") {
              if (exact.state !== "shutdown")
                throw new LocalRefusal(
                  "WORKSPACE_OUTCOME_UNCONFIRMED",
                  "The original stop is not yet confirmed.",
                );
              await this.settleGitHub(next, { state: "stopped", pendingRequestIds: [] });
              return this.githubResource(resourceId, value.requestId);
            }
            await this.settleGitHub(next, { state: "provisioning" });
            await this.state.recordPhase(value.requestId, this.identity, {
              name: "provision",
              resourceGeneration: next.resourceGeneration,
            });
            const result = await this.github.provision(
              {
                requestId: value.requestId,
                resourceId,
                providerResourceName: exact.name,
                repositoryId: next.repositoryId,
                repositoryFullName: next.repositoryFullName,
                ...(previousRepositoryFullName ? { previousRepositoryFullName } : {}),
                resourceGeneration: next.resourceGeneration,
                authorizationGeneration: next.authorizationGeneration,
              },
              {
                signal: abort.signal,
                prepared: async (proof) => {
                  await this.requireGitHubLocalAuthority(next, abort.signal);
                  if (
                    proof.requestId !== value.requestId ||
                    proof.resourceGeneration !== next.resourceGeneration ||
                    proof.authorizationGeneration !== next.authorizationGeneration ||
                    proof.providerResourceName !== next.providerResourceName ||
                    proof.repositoryId !== next.repositoryId ||
                    proof.repositoryFullName !== next.repositoryFullName
                  )
                    throw new LocalRefusal(
                      "LOCAL_IDENTITY_CHANGED",
                      "Measured setup proof differs from its admitted resource.",
                    );
                  await this.state.recordGitHubEnrollmentProof(
                    value.requestId,
                    this.identity,
                    proof,
                  );
                  await this.resourceLane(resourceId, async () => {
                    const current = await this.state.githubBinding(resourceId, this.identity);
                    if (
                      !current ||
                      current.resourceGeneration !== next.resourceGeneration ||
                      abort.signal.aborted
                    )
                      throw new LocalRefusal(
                        "LOCAL_GENERATION_CONFLICT",
                        "Setup was retired before its proof could be bound.",
                      );
                    await this.state.putGitHubBinding(
                      { ...current, setupRequestId: value.requestId },
                      this.identity,
                    );
                  });
                },
                ready: async (health) => {
                  await this.requireGitHubLocalAuthority(next, abort.signal);
                  const proof = await this.state.githubSetupProof(resourceId, this.identity);
                  const observed = this.verifiedGitHubHealth(proof, health);
                  await this.settleGitHub(next, {
                    state: "running",
                    environmentIdentity: proof.environmentIdentity,
                    remote: observed.remote,
                    observedAt: Date.now(),
                  });
                },
                custody: {
                  directory: this.manager.records.state.root,
                  prepared: (witness, securityRequestId) =>
                    this.state.recordCustody(
                      value.requestId,
                      this.identity,
                      witness,
                      securityRequestId,
                    ),
                },
                acquire: (signal) =>
                  this.github.relay.acquireProvisionCredential(
                    resourceId,
                    next.resourceGeneration,
                    signal,
                  ),
                inspect: async (signal) =>
                  providerObservationSchema.parse(
                    await this.github.relay.githubProvider(
                      resourceId,
                      {
                        requestId: value.requestId,
                        resourceGeneration: next.resourceGeneration,
                        action: "get",
                      },
                      signal,
                    ),
                  ),
                enroll: async (proof) => {
                  await this.requireGitHubSetupAuthority(next, abort.signal);
                  const credential = await this.github.relay.enrollGitHubWorkspace(
                    resourceId,
                    proof,
                    abort.signal,
                  );
                  await this.requireGitHubSetupAuthority(next, abort.signal);
                  return credential;
                },
              },
            );
            await this.requireGitHubLocalAuthority(next, abort.signal);
            const savedProof = await this.state.githubSetupProof(resourceId, this.identity);
            if (canonicalJson(savedProof) !== canonicalJson(result.proof))
              throw new LocalRefusal(
                "LOCAL_IDENTITY_CHANGED",
                "Ready workspace must retain its original measured proof.",
              );
            const health = this.verifiedGitHubHealth(result.proof, result.health);
            await this.settleGitHub(next, {
              state: "running",
              environmentIdentity: result.proof.environmentIdentity,
              pendingRequestIds: [],
              observedAt: Date.now(),
              remote: health.remote,
            });
            return this.githubResource(resourceId, value.requestId);
          })
          .catch(async (error: unknown) => {
            custodyUnconfirmed =
              error instanceof LocalRefusal && error.code === "LOCAL_CUSTODY_UNCONFIRMED";
            const effect = this.githubEffects.get(resourceId);
            if (effect?.abort === abort && custodyUnconfirmed) effect.custodyUnconfirmed = true;
            const unconfirmed =
              !(error instanceof LocalRefusal) ||
              custodyUnconfirmed ||
              ["WORKSPACE_OUTCOME_UNCONFIRMED", "WORKSPACE_OUTCOME_UNKNOWN"].includes(error.code) ||
              scopedCredentialFailureOutcome(error.code) === "unconfirmed";
            await this.settleGitHub(next, {
              state: unconfirmed ? "unknown" : "failed",
              ...(unconfirmed ? {} : { pendingRequestIds: [] }),
            }).catch(() => undefined);
            throw unconfirmed && !(error instanceof LocalRefusal)
              ? new LocalRefusal(
                  "WORKSPACE_OUTCOME_UNCONFIRMED",
                  "The admitted provider operation outcome is unconfirmed; collect its original owner identity.",
                )
              : error;
          })
          .finally(() => {
            if (!custodyUnconfirmed && this.githubEffects.get(resourceId)?.abort === abort)
              this.githubEffects.delete(resourceId);
          });
        this.githubEffects.set(resourceId, {
          requestId: value.requestId,
          abort,
          settled,
          custodyUnconfirmed: false,
        });
        return { settled };
      });
      return admitted.settled;
    });
  }
  private verifiedGitHubHealth(proof: GitHubProvisionProof, value: unknown) {
    const health = z
      .object({
        releaseIdentity: z.string(),
        environmentIdentity: z.string(),
        remote: workspaceRemoteObservationSchema,
      })
      .passthrough()
      .parse(value);
    if (
      health.releaseIdentity !== proof.release ||
      health.environmentIdentity !== proof.environmentIdentity
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Workspace health differs from its measured setup proof.",
      );
    return health;
  }
  private async requireGitHubLocalAuthority(
    binding: GitHubControllerResource,
    signal: AbortSignal,
  ) {
    this.requireAdmission();
    const current = await this.state.githubBinding(binding.resourceId, this.identity);
    const connection = await this.manager.records.state.read(
      "connection.json",
      localConnectionSchema.parse,
    );
    if (
      signal.aborted ||
      !current ||
      current.resourceGeneration !== binding.resourceGeneration ||
      current.authorizationGeneration !== binding.authorizationGeneration ||
      current.desiredState !== "running" ||
      current.repositoryId !== binding.repositoryId ||
      current.repositoryFullName !== binding.repositoryFullName ||
      current.providerResourceName !== binding.providerResourceName ||
      !connection ||
      connection.authorityRefused ||
      !identityKeys.every((key) => connection[key] === this.identity[key])
    )
      throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Original setup authority changed.");
  }
  private async requireGitHubSetupAuthority(
    binding: GitHubControllerResource,
    signal: AbortSignal,
  ) {
    await this.requireGitHubLocalAuthority(binding, signal);
    const assignment = await this.github.relay.githubAssignment(binding.resourceId, signal);
    if (
      assignment.resourceGeneration !== binding.resourceGeneration ||
      assignment.authorizationGeneration !== binding.authorizationGeneration ||
      assignment.repositoryId !== binding.repositoryId ||
      assignment.repositoryFullName !== binding.repositoryFullName ||
      assignment.providerResourceName !== binding.providerResourceName ||
      assignment.operationMarker !== binding.operationMarker
    )
      throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Original setup assignment changed.");
    await this.requireGitHubLocalAuthority(binding, signal);
  }
  private async resumeGitHubSetup(
    resourceId: string,
    value: Extract<ControllerGitHubLifecycle, { action: "resume_setup" }>,
  ) {
    await this.requireGitHubReadiness("enrollment");
    await this.requireGitHubCustodySettled(resourceId);
    return this.state.run(value.requestId, this.identity, { resourceId, ...value }, async () => {
      const admitted = await this.resourceLane(resourceId, async () => {
        this.requireAdmission();
        if (this.githubEffects.has(resourceId))
          throw new LocalRefusal(
            "LOCAL_CONTROL_PENDING",
            "Original provisioning is still in progress; inspect its result.",
          );
        await this.requireGitHubCustodySettled(resourceId);
        const binding = await this.state.githubBinding(resourceId, this.identity);
        if (
          !binding ||
          binding.resourceGeneration !== value.expectedGeneration ||
          binding.desiredState !== "running" ||
          binding.retirement !== "owned"
        )
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "Setup continuation requires its same known running resource generation.",
          );
        if (
          binding.remote &&
          !["unconfigured", "enrollment_unavailable"].includes(binding.remote.state)
        )
          throw new LocalRefusal(
            "GITHUB_PROVISIONING_INCOMPLETE",
            "Initial setup continuation requires unenrolled local readiness; current remote authority cannot be replaced.",
          );
        const proof = await this.state.githubSetupProof(resourceId, this.identity);
        const abort = new AbortController();
        await this.state.putGitHubBinding(
          { ...binding, pendingRequestIds: [value.requestId] },
          this.identity,
        );
        await this.state.recordPhase(value.requestId, this.identity, {
          name: "provision",
          resourceGeneration: binding.resourceGeneration,
        });
        let custodyUnconfirmed = false;
        const settled = Promise.resolve()
          .then(async () => {
            await this.requireGitHubSetupAuthority(binding, abort.signal);
            const resume = this.github.resume ?? resumeGitHubWorkspaceEnrollment;
            const result = await resume(
              {
                requestId: proof.requestId,
                resourceId,
                providerResourceName: proof.providerResourceName,
                repositoryId: proof.repositoryId,
                repositoryFullName: proof.repositoryFullName,
                resourceGeneration: proof.resourceGeneration,
                authorizationGeneration: proof.authorizationGeneration,
              },
              proof,
              {
                signal: abort.signal,
                ready: async (health) => {
                  await this.requireGitHubLocalAuthority(binding, abort.signal);
                  const observed = this.verifiedGitHubHealth(proof, health);
                  await this.settleGitHub(binding, {
                    state: "running",
                    environmentIdentity: proof.environmentIdentity,
                    remote: observed.remote,
                    observedAt: Date.now(),
                  });
                },
                custody: {
                  directory: this.manager.records.state.root,
                  prepared: (witness, securityRequestId) =>
                    this.state.recordCustody(
                      value.requestId,
                      this.identity,
                      witness,
                      securityRequestId,
                    ),
                },
                acquire: (signal) =>
                  this.github.relay.acquireProvisionCredential(
                    resourceId,
                    binding.resourceGeneration,
                    signal,
                  ),
                inspect: async (signal) =>
                  providerObservationSchema.parse(
                    await this.github.relay.githubProvider(
                      resourceId,
                      {
                        requestId: value.requestId,
                        resourceGeneration: binding.resourceGeneration,
                        action: "get",
                      },
                      signal,
                    ),
                  ),
                enroll: async (originalProof) => {
                  if (
                    canonicalJson(githubProvisionProofSchema.parse(originalProof)) !==
                    canonicalJson(proof)
                  )
                    throw new LocalRefusal(
                      "LOCAL_REPLAY_CONFLICT",
                      "Setup continuation cannot replace the original measured proof.",
                    );
                  await this.requireGitHubSetupAuthority(binding, abort.signal);
                  const remote = await this.github.relay.enrollGitHubWorkspace(
                    resourceId,
                    proof,
                    abort.signal,
                  );
                  await this.requireGitHubSetupAuthority(binding, abort.signal);
                  return remote;
                },
              },
            );
            await this.requireGitHubLocalAuthority(binding, abort.signal);
            const health = this.verifiedGitHubHealth(proof, result.health);
            if (canonicalJson(result.proof) !== canonicalJson(proof))
              throw new LocalRefusal(
                "LOCAL_IDENTITY_CHANGED",
                "Setup continuation changed its original proof.",
              );
            await this.settleGitHub(binding, {
              state: "running",
              environmentIdentity: proof.environmentIdentity,
              remote: health.remote,
              pendingRequestIds: [],
              observedAt: Date.now(),
            });
            return this.githubResource(resourceId, value.requestId);
          })
          .catch(async (error: unknown) => {
            custodyUnconfirmed =
              error instanceof LocalRefusal && error.code === "LOCAL_CUSTODY_UNCONFIRMED";
            const effect = this.githubEffects.get(resourceId);
            if (effect?.abort === abort) effect.custodyUnconfirmed = custodyUnconfirmed;
            await this.settleGitHub(binding, {
              ...(custodyUnconfirmed ? { state: "unknown" as const } : { pendingRequestIds: [] }),
            });
            throw error;
          })
          .finally(() => {
            if (!custodyUnconfirmed && this.githubEffects.get(resourceId)?.abort === abort)
              this.githubEffects.delete(resourceId);
          });
        this.githubEffects.set(resourceId, {
          requestId: value.requestId,
          abort,
          settled,
          custodyUnconfirmed: false,
        });
        return { settled };
      });
      return admitted.settled;
    });
  }
  /** Pure original-process proof and exact child disposal; never restarts SSH or GitHub lifecycle. */
  async collectOperation(requestId: string) {
    const original = await this.state.inspect(requestId, this.identity);
    if (
      original.state === "accepted" ||
      original.state === "absent" ||
      (original.state === "completed" &&
        (original.outcome?.ok !== false ||
          ![
            "LOCAL_CUSTODY_UNCONFIRMED",
            "WORKSPACE_OUTCOME_UNCONFIRMED",
            "WORKSPACE_OUTCOME_UNKNOWN",
          ].includes(original.outcome.error.code)))
    )
      return original;
    const custody = await this.state.custody(requestId, this.identity);
    if (!custody?.witnesses.length) {
      const creation = await this.state.originalProviderCreation(requestId, this.identity);
      if (!creation) return original;
      try {
        return await this.resourceLane(creation.resourceId, async () => {
          const binding = await this.state.githubBinding(creation.resourceId, this.identity);
          if (!binding || binding.resourceGeneration !== creation.resourceGeneration)
            return original;
          const assignment = await this.github.relay.githubAssignment(creation.resourceId);
          if (
            assignment.resourceGeneration !== binding.resourceGeneration ||
            assignment.authorizationGeneration !== binding.authorizationGeneration ||
            assignment.repositoryId !== binding.repositoryId ||
            assignment.repositoryFullName !== binding.repositoryFullName ||
            assignment.operationMarker !== binding.operationMarker
          )
            return original;
          const found = providerObservationSchema.nullable().parse(
            await this.github.relay.githubProvider(creation.resourceId, {
              requestId,
              resourceGeneration: creation.resourceGeneration,
              action: "get",
            }),
          );
          // Empty marker discovery, including an uncreated/retired projection,
          // cannot prove that the original provider POST never happened.
          if (
            !found ||
            found.repositoryId !== binding.repositoryId ||
            found.repositoryFullName !== binding.repositoryFullName ||
            (binding.providerResourceName && binding.providerResourceName !== found.name)
          )
            return original;
          await this.github.relay.registerGitHubResource(creation.resourceId, {
            requestId,
            resourceGeneration: creation.resourceGeneration,
            authorizationGeneration: binding.authorizationGeneration,
            providerResourceName: found.name,
            retirement: "owned",
          });
          await this.state.putGitHubBinding(
            {
              ...binding,
              providerResourceName: found.name,
              retirement: "owned",
              state: "provisioning",
              providerResource: found,
              observedAt: Date.now(),
              pendingRequestIds: [],
            },
            this.identity,
          );
          await this.state.settleObservedCreation(requestId, this.identity);
          return this.state.inspect(requestId, this.identity);
        });
      } catch {
        return original;
      }
    }
    try {
      const security = await this.github.relay.collectProvisionCredential(
        custody.securityRequestId,
        custody,
      );
      if (!security || !["disposed", "absent", "refused"].includes(security.state)) return original;
      await this.state.settleCustody(requestId, this.identity);
      if (this.githubEffects.get(custody.resourceId)?.requestId === requestId)
        this.githubEffects.delete(custody.resourceId);
      return this.state.inspect(requestId, this.identity);
    } catch {
      // Missing, pending, substituted or unreadable native proof never becomes closure.
      return original;
    }
  }
  private async drainGitHubForReauthorization(resourceId: string): Promise<void> {
    const previous = this.githubEffects.get(resourceId);
    if (previous) {
      previous.abort.abort();
      await previous.settled.catch(() => undefined);
      await this.state.waitForOperation(previous.requestId, this.identity);
    }
    const pending = await this.state.pendingResources(this.identity);
    for (const requestId of pending.get(resourceId) ?? []) await this.collectOperation(requestId);
    await this.requireGitHubCustodySettled(resourceId);
  }
  private async requireGitHubCustodySettled(resourceId: string): Promise<void> {
    const effect = this.githubEffects.get(resourceId);
    if (effect?.custodyUnconfirmed)
      throw new LocalRefusal(
        "LOCAL_CUSTODY_UNCONFIRMED",
        "Original host provisioning custody remains unconfirmed.",
      );
    await this.state.requireGitHubCustodySettled(
      resourceId,
      new Set(effect ? [effect.requestId] : []),
    );
  }
  private async requireGitHubReadiness(purpose: GitHubReadinessPurpose = "install"): Promise<void> {
    if ((await this.github.readiness(purpose)).state !== "available")
      throw new LocalRefusal(
        "GITHUB_PROVISIONING_UNAVAILABLE",
        purpose === "install"
          ? "The paired controller requires its verified GitHub tools and both workspace payloads before provisioning."
          : "The paired controller requires its verified GitHub tools before enrollment continuation.",
      );
  }
  private async observeGitHub(
    binding: GitHubControllerResource,
    requestId: string,
    action: string,
    initial: unknown,
    signal: AbortSignal,
  ) {
    let observed = initial;
    for (;;) {
      if (signal.aborted)
        throw new LocalRefusal(
          "LOCAL_OPERATION_RETIRED",
          "A newer owner operation retired this provisioning work.",
        );
      if (observed === undefined || observed === null) {
        observed = await this.github.relay.githubProvider(
          binding.resourceId,
          { requestId, resourceGeneration: binding.resourceGeneration, action: "get" },
          signal,
        );
        if (observed === null) {
          if (action === "delete") return null;
          throw new LocalRefusal(
            "WORKSPACE_OUTCOME_UNCONFIRMED",
            "The original provider identity is not confirmed; collect before any new creation.",
          );
        }
      }
      const exact = providerObservationSchema.parse(observed);
      if (
        exact.repositoryId !== binding.repositoryId ||
        exact.repositoryFullName.toLowerCase() !== binding.repositoryFullName.toLowerCase() ||
        (binding.providerResourceName && exact.name !== binding.providerResourceName)
      )
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "Provider observation differs from its original resource authority.",
        );
      if (
        (action === "stop" && exact.state === "shutdown") ||
        (!["stop", "delete"].includes(action) && exact.state === "available")
      )
        return exact;
      if (exact.state === "failed")
        throw new LocalRefusal(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "The provider reported a failed physical workspace.",
        );
      // Scheduling observes the original physical operation; it never retries its mutation
      // or invents a workload deadline. Explicit lifecycle cancellation retires this wait.
      await waitForObservation(1_000, undefined, { signal });
      observed = await this.github.relay.githubProvider(
        binding.resourceId,
        { requestId, resourceGeneration: binding.resourceGeneration, action: "get" },
        signal,
      );
    }
  }
  private async settleGitHub(
    binding: GitHubControllerResource,
    change: Partial<GitHubControllerResource>,
  ) {
    await this.resourceLane(binding.resourceId, async () => {
      const current = await this.state.githubBinding(binding.resourceId, this.identity);
      if (!current || current.resourceGeneration !== binding.resourceGeneration) return;
      await this.state.putGitHubBinding({ ...current, ...change }, this.identity);
    });
  }
  private async githubResource(resourceId: string, completingRequestId?: string) {
    const resource = (await this.managementSnapshot(completingRequestId)).github.resources.find(
      (entry) => entry.resourceId === resourceId,
    );
    if (!resource)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "No owner resource observation is available.",
      );
    return resource;
  }
  private async localResources(resourceId?: string) {
    const policy = await this.manager.records.policy();
    const bindings = (await this.state.bindings(this.identity)).filter(
      (binding) => resourceId === undefined || binding.resourceId === resourceId,
    );
    const pendingResources = await this.state.pendingResources(this.identity);
    if (resourceId !== undefined && bindings.length !== 1 && !pendingResources.has(resourceId))
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The selected resource has no owner binding.",
      );
    const selected = bindings[0];
    let snapshot: Awaited<ReturnType<LocalManager["snapshot"]>>;
    let resourceObservation: { state: "available" | "unavailable"; code?: string } = {
      state: "available",
    };
    try {
      snapshot =
        resourceId !== undefined && !selected?.localSpaceId
          ? { ...publicPolicy(policy), spaces: [] }
          : await this.manager.snapshot(
              resourceId === undefined ? undefined : selected.localSpaceId!,
            );
    } catch (error) {
      snapshot = { ...publicPolicy(policy), spaces: [] };
      resourceObservation = {
        state: "unavailable",
        code: error instanceof LocalRefusal ? error.code : "LOCAL_RUNTIME_UNAVAILABLE",
      };
    }
    if (
      resourceId !== undefined &&
      canonicalJson((await this.state.binding(resourceId, this.identity)) ?? null) !==
        canonicalJson(selected ?? null)
    )
      throw new LocalRefusal(
        "LOCAL_GENERATION_CONFLICT",
        "The selected resource changed during observation.",
      );
    const resources = bindings.map((binding) => ({
      resourceId: binding.resourceId,
      resourceGeneration: binding.resourceGeneration,
      routeGeneration: binding.routeGeneration ?? binding.resourceGeneration,
      repositoryId: binding.repositoryId,
      profileId: "local-approved",
      space: snapshot.spaces.find((space) => space.id === binding.localSpaceId) ?? null,
      creationClosed: binding.creationClosed,
      pendingRequestIds: pendingResources.get(binding.resourceId) ?? [],
    }));
    return {
      resources,
      pendingResourceOperations: [...pendingResources]
        .filter(([id]) => resourceId === undefined || id === resourceId)
        .map(([resourceId, requestIds]) => ({ resourceId, requestIds })),
      resourceObservation,
    };
  }
  private async localMetadata(completingRequestId?: string) {
    const policy = await this.manager.records.policy();
    const report = await this.control.report(
      { ...this.identity, origin: await this.origin() },
      policy,
    );
    const admissions =
      (await this.manager.records.state.read("controller-repository-admissions.json", (value) =>
        z.array(localRepositoryAdmissionReceiptSchema).parse(value),
      )) ?? [];
    const settingsEffect = await this.manager.records.state.read(
      "controller-settings-current.json",
      (value) =>
        z
          .object({ requestId: z.string(), revision: z.number().int().nonnegative() })
          .strict()
          .parse(value),
    );
    const settingsOperation = settingsEffect
      ? await this.state.inspect(settingsEffect.requestId, this.identity)
      : undefined;
    const pending =
      settingsEffect &&
      settingsEffect.requestId !== completingRequestId &&
      (settingsOperation?.state === "accepted" || settingsOperation?.state === "unconfirmed")
        ? settingsEffect
        : undefined;
    const appliedRevision = policy.appliedRevision;
    const revision = Math.max(
      appliedRevision,
      report?.rejectedRevision ?? 0,
      settingsEffect?.revision ?? 0,
    );
    return {
      version: 1,
      ...this.identity,
      ownerConnectionId: this.identity.connectionId,
      policy: publicPolicy(policy),
      control: {
        optedIn: Boolean(report),
        revision,
        appliedRevision,
        status: pending
          ? "pending"
          : report?.error
            ? "rejected"
            : report
              ? "applied"
              : "not-enabled",
        settings: report?.settings ?? controlSettings(policy),
        ceiling: report?.ceiling ?? null,
        error: report?.error ?? null,
        repositoryAdmissions: admissions,
        ...(pending ? { pendingRequestId: pending.requestId } : {}),
        appliedAgentRepositoryManagement: policy.agentRepositoryManagement,
      },
      observedAt: Date.now(),
    };
  }
  private async origin(): Promise<string> {
    const connection = await this.manager.records.state.read("connection.json", (value) =>
      z.object({ origin: z.string().url() }).passthrough().parse(value),
    );
    if (!connection)
      throw new LocalRefusal(
        "LOCAL_NOT_ENROLLED",
        "Pair this controller before remote management.",
      );
    return connection.origin;
  }
  async settings(input: unknown) {
    this.requireAdmission();
    await this.manager.records.policy();
    const value = controllerSettingsSchema.parse(input);
    if (value.expectedGeneration !== this.identity.deviceGeneration)
      throw new LocalRefusal("LOCAL_GENERATION_CONFLICT", "Device generation changed.");
    return this.state.run(value.requestId, this.identity, { action: "settings", ...value }, () =>
      this.settingsLane(async () => {
        this.requireAdmission();
        const snapshot = await this.localMetadata();
        if (await this.control.hasUnsettledEffect())
          throw new LocalRefusal(
            "LOCAL_CONTROL_PENDING",
            "A previous physical settings effect needs owner settlement; do not replay it.",
          );
        if (!snapshot.control.optedIn || !snapshot.control.ceiling)
          throw new LocalRefusal(
            "LOCAL_UNAUTHORIZED",
            "Approve web control on this computer first.",
          );
        if (value.expectedRevision !== snapshot.control.revision)
          throw new LocalRefusal(
            "LOCAL_CONTROL_CONFLICT",
            "Settings revision changed; read the current owner view.",
          );
        await this.manager.records.state.write("controller-settings-current.json", {
          requestId: value.requestId,
          revision: value.expectedRevision + 1,
        });
        const applied = await this.control.apply(
          localDeviceControlViewSchema.parse({
            ...snapshot.control,
            status: "pending",
            revision: value.expectedRevision + 1,
            settings: value.settings,
          }),
          this.manager,
        );
        if (!applied) {
          const failed = await this.control.report({
            ...this.identity,
            origin: await this.origin(),
          });
          throw new LocalRefusal(
            failed?.error?.code ?? "LOCAL_CONTROL_FAILED",
            failed?.error?.message ?? "Owner settings did not apply.",
          );
        }
        return this.managementSnapshot(value.requestId);
      }),
    );
  }
  async repository(input: unknown) {
    this.requireAdmission();
    await this.manager.records.policy();
    const value = controllerRepositorySchema.parse(input);
    if (value.deviceGeneration !== this.identity.deviceGeneration)
      throw new LocalRefusal(
        "LOCAL_GENERATION_CONFLICT",
        "Device authority changed before repository admission.",
      );
    return this.state.run(value.requestId, this.identity, { action: "repository", ...value }, () =>
      this.settingsLane(async () => {
        this.requireAdmission();
        const snapshot = await this.localMetadata();
        if (!snapshot.control.optedIn || value.expectedRevision !== snapshot.control.revision)
          throw new LocalRefusal(
            "LOCAL_CONTROL_CONFLICT",
            "Read current locally approved delegation before repository admission.",
          );
        if (await this.control.hasUnsettledEffect())
          throw new LocalRefusal(
            "LOCAL_CONTROL_PENDING",
            "Prior physical settings effect is unsettled.",
          );
        try {
          assertAgentRepositoryAdmission(
            snapshot.control.settings.agentRepositoryManagement,
            value.repository,
            value.creationRequestId ? "created" : "existing",
          );
        } catch {
          throw new LocalRefusal(
            "LOCAL_REPOSITORY_DENIED",
            "Repository exceeds the applied owner delegation.",
          );
        }
        if (
          snapshot.control.settings.repositories.some(
            (repository) =>
              repository.id === value.repository.id ||
              repository.fullName.toLowerCase() === value.repository.fullName.toLowerCase(),
          )
        )
          throw new LocalRefusal(
            "LOCAL_CONTROL_CONFLICT",
            "Repository already has a locally approved grant.",
          );
        const receipt = localRepositoryAdmissionReceiptSchema.parse({
          requestId: value.requestId.slice(4),
          githubRepositoryId: value.githubRepositoryId,
          localRepositoryId: value.repository.id,
          revision: value.expectedRevision + 1,
          deviceGeneration: this.identity.deviceGeneration,
          connectionId: this.identity.connectionId,
          repository: value.repository,
          ...(value.creationRequestId ? { creationRequestId: value.creationRequestId } : {}),
        });
        const admissions = [...snapshot.control.repositoryAdmissions, receipt];
        await this.manager.records.state.write("controller-repository-admissions.json", admissions);
        const applied = await this.control.apply(
          localDeviceControlViewSchema.parse({
            ...snapshot.control,
            revision: receipt.revision,
            status: "pending",
            repositoryAdmissions: admissions,
            settings: {
              ...snapshot.control.settings,
              repositories: [...snapshot.control.settings.repositories, value.repository],
            },
          }),
          this.manager,
          "repository",
        );
        if (!applied)
          throw new LocalRefusal(
            "LOCAL_CONTROL_FAILED",
            "Locally delegated repository admission did not complete.",
          );
        return this.managementSnapshot();
      }),
    );
  }
  async lifecycle(resourceId: string, input: unknown, localOwner = false) {
    this.requireAdmission();
    await this.manager.records.policy();
    z.string().uuid().parse(resourceId);
    const value = controllerLifecycleSchema.parse(input);
    if (value.action === "snapshot")
      return {
        requestId: value.requestId,
        state: "completed" as const,
        outcome: { ok: true as const, result: await this.resource(resourceId, value) },
      };
    const operation = this.state.run(
      value.requestId,
      this.identity,
      { resourceId, ...value, localOwner },
      async () => {
        const admitted = await this.resourceLane(resourceId, async () => {
          this.requireAdmission();
          let binding: ControllerBinding | undefined;
          let effect: Promise<unknown>;
          let releaseAdmission!: () => void;
          let nativePublished = false;
          const nativeAdmission = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
          const publishAdmission = async () => {
            if (!binding)
              throw new LocalRefusal(
                "LOCAL_IDENTITY_CHANGED",
                "Controller native admission is absent.",
              );
            const admittedBinding = binding;
            const current = await this.state.binding(resourceId, this.identity);
            if (!current || current.resourceGeneration !== admittedBinding.resourceGeneration)
              throw new LocalRefusal(
                "LOCAL_GENERATION_CONFLICT",
                "Native preparation was superseded by another owner operation.",
              );
            const spaces = (await this.manager.records.list()).filter(
              (space) =>
                space.operationMarker === admittedBinding.operationMarker &&
                space.repositoryId === admittedBinding.repositoryId,
            );
            if (spaces.length !== 1)
              throw new LocalRefusal(
                "LOCAL_IDENTITY_CHANGED",
                "Native admission has no unique owned manifest.",
              );
            binding.localSpaceId = spaces[0].id;
            binding.localGeneration = spaces[0].generation;
            await this.state.putBinding(binding);
          };
          const captureAdmission = async () => {
            // An active guard may fall back to native prepare and notify again.
            // Later notifications must reacquire admission CAS; they cannot restore
            // an old binding after a newer stop has already consumed its generation.
            if (nativePublished) await this.resourceLane(resourceId, publishAdmission);
            else await publishAdmission();
            nativePublished = true;
            releaseAdmission();
          };
          try {
            if (value.action === "create") {
              const policy = await this.manager.records.policy();
              requireLocalGrant(policy, value.repositoryId);
              if (await this.state.binding(resourceId, this.identity))
                throw new LocalRefusal(
                  "LOCAL_CREATE_UNKNOWN",
                  "This resource already retains a native creation identity; inspect it.",
                );
              if (
                (await this.state.bindings(this.identity)).some(
                  (binding) => binding.operationMarker === value.operationMarker,
                )
              )
                throw new LocalRefusal(
                  "LOCAL_REPLAY_CONFLICT",
                  "Creation marker already belongs to another resource.",
                );
              binding = {
                ...this.identity,
                resourceId,
                resourceGeneration: value.expectedGeneration,
                routeGeneration: value.expectedGeneration,
                repositoryId: value.repositoryId,
                operationMarker: value.operationMarker,
                localSpaceId: null,
                localGeneration: null,
                creationClosed: false,
              };
              await this.state.putBinding(binding);
              if (localOwner) {
                if (value.expectedGeneration !== 1)
                  throw new LocalRefusal(
                    "LOCAL_GENERATION_CONFLICT",
                    "A new owner resource starts at generation one.",
                  );
                await this.registerResource({
                  resourceId,
                  repositoryId: value.repositoryId,
                  resourceGeneration: 1,
                  operationMarker: value.operationMarker,
                  ref: value.ref,
                });
              }
              await this.manager.open();
              effect = this.manager.create(
                value.repositoryId,
                value.ref,
                value.operationMarker,
                captureAdmission,
              );
            } else {
              binding = await this.requireBinding(resourceId, value.expectedGeneration);
              const space = await this.manager.require(binding.localSpaceId!);
              if (
                (value.action === "start" || value.action === "resume_setup") &&
                space.generation !== binding.localGeneration &&
                space.recoveryGeneration !== space.generation
              )
                throw new LocalRefusal(
                  "LOCAL_GENERATION_CONFLICT",
                  "Native generation changed without confirmed owner recovery.",
                );
              if (
                value.action === "delete" &&
                value.ownerConfirmed &&
                !localOwner &&
                !(await this.control.report({ ...this.identity, origin: await this.origin() }))
              )
                throw new LocalRefusal(
                  "LOCAL_UNAUTHORIZED",
                  "Owner cleanup requires locally approved web control.",
                );
              // The original native-effect admission consumes this CAS generation.
              // Uncertain effects cannot leave an old UI generation valid for another action.
              binding.routeGeneration ??= binding.resourceGeneration;
              binding.resourceGeneration++;
              await this.state.putBinding(binding);
              if (value.action === "start" || value.action === "resume_setup") {
                await this.manager.open();
                effect =
                  value.action === "resume_setup"
                    ? this.manager.resumeSetup(space.id, captureAdmission)
                    : this.manager.start(space.id, captureAdmission);
              } else if (value.action === "stop")
                effect = this.manager.stop(space.id, space.generation);
              else {
                effect = this.manager.remove(space.id, space.generation, value.ownerConfirmed);
              }
            }
            // Preparation publishes exact native admission before long work. Stop
            // uses the native owner's retire gate and must not wait for that preparation.
            if (["create", "start", "resume_setup"].includes(value.action))
              await Promise.race([nativeAdmission, effect.then(() => undefined)]);
            return { binding, effect };
          } catch (error) {
            if (binding) {
              const failedBinding = binding;
              const spaces = (await this.manager.records.list()).filter(
                (space) =>
                  space.operationMarker === failedBinding.operationMarker &&
                  space.repositoryId === failedBinding.repositoryId,
              );
              if (spaces.length === 1) {
                binding.localSpaceId = spaces[0].id;
                binding.localGeneration = spaces[0].generation;
              }
              if (!binding.localSpaceId) binding.creationClosed = true;
              await this.state.putBinding(binding);
            }
            throw error;
          }
        });
        try {
          await admitted.effect;
        } finally {
          await this.resourceLane(resourceId, async () => {
            const latest = await this.state.binding(resourceId, this.identity);
            if (!latest || latest.resourceGeneration !== admitted.binding.resourceGeneration)
              return;
            const spaces = (await this.manager.records.list()).filter(
              (space) =>
                space.operationMarker === latest.operationMarker &&
                space.repositoryId === latest.repositoryId,
            );
            if (spaces.length === 1) {
              latest.localSpaceId = spaces[0].id;
              latest.localGeneration = spaces[0].generation;
            }
            if (!latest.localSpaceId) latest.creationClosed = true;
            await this.state.putBinding(latest);
          });
        }
        return this.resource(resourceId, {
          ...value,
          expectedGeneration: admitted.binding.resourceGeneration,
        });
      },
    );
    if (value.action === "stop" || value.action === "delete") {
      this.physicalClosures.add(operation);
      void operation.finally(() => this.physicalClosures.delete(operation)).catch(() => undefined);
    }
    return operation;
  }
  private async requireBinding(resourceId: string, expectedGeneration: number) {
    const binding = await this.state.binding(resourceId, this.identity);
    if (!binding?.localSpaceId)
      throw new LocalRefusal(
        "LOCAL_CREATE_UNKNOWN",
        "No confirmed native identity exists for this resource.",
      );
    if (expectedGeneration !== binding.resourceGeneration)
      throw new LocalRefusal(
        "LOCAL_GENERATION_CONFLICT",
        "Resource generation differs from its current owner binding.",
      );
    const space = await this.manager.records.get(binding.localSpaceId);
    if (
      !space ||
      space.repositoryId !== binding.repositoryId ||
      space.operationMarker !== binding.operationMarker
    )
      throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Native resource binding changed.");
    return binding;
  }
  private async resource(resourceId: string, value: ControllerLifecycle) {
    const binding = await this.requireBinding(resourceId, value.expectedGeneration);
    const snapshot = await this.manager.snapshot(
      binding.localSpaceId!,
      value.action === "delete" && value.ownerConfirmed,
    );
    return {
      resourceId,
      resourceGeneration: binding.resourceGeneration,
      observedAt: Date.now(),
      creation: { state: "manifest", spaceId: binding.localSpaceId },
      ...snapshot,
    };
  }
}

/** Owner-only IPC; the same endpoint serves the local CLI and the authenticated outbound channel. */
export async function startLocalController(controller: LocalController) {
  await controller.initialize();
  const directory = await controller.manager.records.state.ipcDirectory();
  const socketPath = join(directory.root, "controller.sock");
  const parent = await lstat(directory.root);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    parent.uid !== process.getuid?.()
  )
    throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe controller socket directory.");
  const old = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (old) {
    if (!old.isSocket() || old.uid !== parent.uid || old.mode & 0o077)
      throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe controller endpoint.");
    // A reused manager already owns the runner gate, so that gate alone cannot
    // justify replacing an endpoint still served by this process.
    await new Promise<void>((resolve, reject) => {
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(
          new LocalRefusal(
            "LOCAL_CONTROLLER_RUNNING",
            "An owner controller is already serving this endpoint.",
          ),
        );
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy();
        if (error.code === "ECONNREFUSED") resolve();
        else reject(error);
      });
    });
    const current = await lstat(socketPath);
    if (current.dev !== old.dev || current.ino !== old.ino)
      throw new LocalRefusal("LOCAL_STATE_CHANGED", "Controller endpoint changed.");
    await unlink(socketPath);
  }
  const incarnation = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    let originalRequestId: string | undefined;
    let dispatched = false;
    void (async () => {
      const localOwner = controller.authorize(request);
      let result: unknown;
      const path = request.url ?? "";
      if (request.method === "GET" && path === "/v1/controller/health")
        result = { connectionId: controller.identity.connectionId, incarnation };
      else if (request.method === "GET" && path === "/v1/controller")
        result = await controller.snapshot();
      else if (request.method === "GET" && path === "/v1/controller/management")
        result = await controller.managementSnapshot();
      else if (
        request.method === "GET" &&
        /^\/v1\/controller\/resources\/[a-f0-9-]{36}$/.test(path)
      )
        result = await controller.snapshot(
          undefined,
          z.string().uuid().parse(path.split("/").at(-1)),
        );
      else if (request.method === "GET" && /^\/v1\/publications\/[A-Za-z0-9_-]{43}$/.test(path)) {
        await (
          await controller.communication()
        ).publications.serve(path.split("/").at(-1)!, response);
        return;
      } else if (
        request.method === "GET" &&
        /^\/v1\/communication\/operations\/ws1-[a-f0-9-]+$/.test(path)
      ) {
        const requestId = path.split("/").at(-1)!;
        result = await (await controller.communication()).delivery.inspect(requestId);
        if ((result as { state: string }).state === "absent")
          result = await controller.state.inspect(requestId, controller.identity);
      } else if (request.method === "POST" && path === "/v1/communication/stream") {
        if (request.headers["content-type"] !== OWNER_STREAM_CONTENT_TYPE)
          throw new LocalRefusal("LOCAL_REQUEST_INVALID", "Communication input is required.");
        const frame = await readOwnerFrame(request);
        try {
          const body = communicationOwnerSubmitSchema.parse(frame.control);
          if (body.source.type !== "stream")
            throw new LocalRefusal("LOCAL_REQUEST_INVALID", "An opaque stream source is required.");
          result = await (
            await controller.communication()
          ).delivery.submit(body, { stream: frame.body });
        } finally {
          settleOwnerFrame(request, response, frame);
        }
      } else if (
        request.method === "GET" &&
        /^\/v1\/controller\/operations\/ws1-[a-f0-9-]+$/.test(path)
      )
        result = await controller.collectOperation(path.split("/").at(-1)!);
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const identity = z
          .object({ requestId: controllerRequestIdSchema })
          .passthrough()
          .safeParse(body);
        originalRequestId = identity.success ? identity.data.requestId : undefined;
        const resource = /^\/v1\/resources\/([a-f0-9-]{36})\/lifecycle$/.exec(path);
        const githubResource = /^\/v1\/controller\/github\/resources\/([a-f0-9-]{36})$/.exec(path);
        if (request.method === "POST" && path === "/v1/communication") {
          result = await (await controller.communication()).delivery.submit(body);
        } else if (request.method === "POST" && path === "/v1/controller/workspaces/resolve") {
          result = await controller.resolveWorkspace(body);
        } else if (request.method === "POST" && path === "/v1/controller/operations/find") {
          result = await controller.findOperations(body);
        } else if (request.method === "PUT" && path === "/v1/controller/settings") {
          dispatched = true;
          result = await controller.settings(body);
        } else if (request.method === "POST" && path === "/v1/controller/repositories") {
          dispatched = true;
          result = await controller.repository(body);
        } else if (request.method === "POST" && resource) {
          dispatched = true;
          result = await controller.lifecycle(resource[1], body, localOwner);
        } else if (request.method === "POST" && githubResource) {
          dispatched = true;
          result = await controller.githubLifecycle(githubResource[1], body);
        } else {
          response.writeHead(404).end();
          return;
        }
      }
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(result));
    })().catch((error) => {
      if (response.headersSent || response.destroyed) return;
      if (request.url === "/v1/communication/stream") settleOwnerFrame(request, response);
      if (
        (request.url ?? "").startsWith("/v1/communication") &&
        typeof error.publicCode === "string" &&
        /^[A-Z_]+$/.test(error.publicCode)
      ) {
        response
          .writeHead([400, 403, 409, 422, 503].includes(error.status) ? error.status : 409, {
            "content-type": "application/json",
          })
          .end(JSON.stringify({ error: { code: error.publicCode, message: error.publicCode } }));
        return;
      }
      if (
        dispatched &&
        originalRequestId &&
        !(error instanceof z.ZodError) &&
        !(error instanceof LocalRefusal)
      ) {
        // Failed observation/storage does not prove that admission was absent.
        // Collect the original owner identity; never invent a replacement request.
        response
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ requestId: originalRequestId, state: "unconfirmed" }));
        return;
      }
      response
        .writeHead(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(
          JSON.stringify({
            error: {
              code: error instanceof LocalRefusal ? error.code : "LOCAL_REQUEST_INVALID",
              message:
                error instanceof LocalRefusal
                  ? error.message
                  : "Controller request was refused before dispatch.",
            },
          }),
        );
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const own = await lstat(socketPath);
  let detached: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const detach = (): Promise<void> => {
    controller.fenceAdmission();
    return (detached ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (current?.dev === own.dev && current.ino === own.ino) await unlink(socketPath);
      const named = await lstat(directory.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (named?.dev === parent.dev && named.ino === parent.ino)
        await rmdir(directory.root).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        });
    })());
  };
  return {
    socketPath,
    connectionId: controller.identity.connectionId,
    incarnation,
    detach,
    retire: () => controller.retire(),
    close: () =>
      (closing ??= (async () => {
        await detach();
        await controller.stopProvisioning();
        await controller.closeCommunication();
        await controller.state.drain();
      })()),
  };
}

export function controllerRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode !== 200)
              return reject(
                new LocalRefusal("LOCAL_CONTROLLER_REFUSED", "Controller refused this request."),
              );
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
