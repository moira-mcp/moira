import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../shared/src/utils/canonical-json.js";
import {
  controllerIdentitySchema,
  controllerRequestIdSchema,
  controllerOperationDescriptorSchema,
  controllerOperationFindSchema,
  githubControllerResourceSchema,
  providerFailureSchema,
  type GitHubControllerResource,
  type ControllerIdentity,
  type ControllerOperation,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import { LocalRecords, type LocalSpace } from "./space-record.js";
import { LocalRefusal } from "./policy.js";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.js";
import { processCustodyWitnessSchema, type ProcessCustodyWitness } from "./process-custody.js";

export const controllerBindingSchema = controllerIdentitySchema
  .extend({
    resourceId: z.string().uuid(),
    resourceGeneration: z.number().int().positive(),
    routeGeneration: z.number().int().positive().optional(),
    repositoryId: z.string().uuid(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    localSpaceId: z.string().uuid().nullable(),
    localGeneration: z.number().int().positive().nullable(),
    creationClosed: z.boolean().default(false),
  })
  .strict();
export type ControllerBinding = z.infer<typeof controllerBindingSchema>;
const githubBindingSchema = githubControllerResourceSchema
  .extend(controllerIdentitySchema.shape)
  .strict();
export type ControllerGitHubBinding = z.infer<typeof githubBindingSchema>;
const operationSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    identity: controllerIdentitySchema,
    resourceId: z.string().uuid().optional(),
    descriptor: controllerOperationDescriptorSchema.optional(),
    state: z.enum(["accepted", "completed"]),
    outcome: z.unknown().optional(),
    originalOutcome: z.unknown().optional(),
    custody: z
      .object({
        securityRequestId: controllerRequestIdSchema,
        witnesses: z.array(processCustodyWitnessSchema),
      })
      .strict()
      .optional(),
    phase: z
      .object({
        name: z.enum([
          "provider_create",
          "provider_start",
          "provider_stop",
          "provider_delete",
          "provision",
        ]),
        resourceGeneration: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
const sameIdentity = (left: ControllerIdentity, right: ControllerIdentity) =>
  (["userId", "deviceId", "deviceGeneration", "connectionId"] as const).every(
    (key) => left[key] === right[key],
  );

/** New controller records never execute an archived relay request. */
export class ControllerState {
  private pending = new Map<string, Promise<ControllerOperation>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly records: LocalRecords) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => undefined).then(action);
    this.tail = work;
    return work;
  }
  async importBindings(identity: ControllerIdentity): Promise<void> {
    identity = controllerIdentitySchema.parse(identity);
    // The companion already holds the native private-state runner gate.
    for (const key of await this.records.state.keys("relay-space-")) {
      const old = await this.records.state.read(key, (value) =>
        z
          .object({
            ...controllerIdentitySchema.shape,
            resourceId: z.string().uuid(),
            serverGeneration: z.number().int().positive(),
            repositoryId: z.string().uuid(),
            createMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
            localSpaceId: z.string().uuid().nullable(),
            localGeneration: z.number().int().positive().nullable(),
            creationClosed: z.boolean().optional(),
          })
          .passthrough()
          .parse(value),
      );
      if (!old || !sameIdentity(old, identity)) continue;
      const existing = await this.binding(old.resourceId, identity);
      if (existing) continue;
      if (old.localSpaceId) {
        const space = await this.records.get(old.localSpaceId);
        if (
          !space ||
          space.repositoryId !== old.repositoryId ||
          space.operationMarker !== old.createMarker
        )
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "Archived binding does not match its owned native record.",
          );
      }
      await this.putBinding({
        ...identity,
        resourceId: old.resourceId,
        resourceGeneration: old.serverGeneration,
        routeGeneration: old.serverGeneration,
        repositoryId: old.repositoryId,
        operationMarker: old.createMarker,
        localSpaceId: old.localSpaceId,
        localGeneration: old.localGeneration,
        creationClosed: old.creationClosed === true || old.localSpaceId === null,
      });
    }
    // Retain every legacy byte in place, isolated from the new dispatcher. This marker
    // records the inventory; no old intent or accepted receipt is converted to runnable work.
    if (!(await this.records.state.read("controller-legacy-archive.json", (value) => value))) {
      const keys = (
        await Promise.all(
          ["relay-space-", "lifecycle-", "request-", "result-"].map((prefix) =>
            this.records.state.keys(prefix),
          ),
        )
      ).flat();
      await this.records.state.write("controller-legacy-archive.json", {
        version: 1,
        keys: [...new Set(keys)].sort(),
      });
    }
  }
  async binding(
    resourceId: string,
    identity: ControllerIdentity,
  ): Promise<ControllerBinding | null> {
    z.string().uuid().parse(resourceId);
    const binding = await this.records.state.read(
      `controller-resource-${resourceId}.json`,
      controllerBindingSchema.parse,
    );
    if (binding && !sameIdentity(binding, identity))
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Controller binding belongs to another device authority.",
      );
    return binding;
  }
  async bindings(identity: ControllerIdentity): Promise<ControllerBinding[]> {
    const bindings: ControllerBinding[] = [];
    for (const key of await this.records.state.keys("controller-resource-")) {
      const binding = await this.records.state.read(key, controllerBindingSchema.parse);
      if (binding && sameIdentity(binding, identity)) bindings.push(binding);
    }
    return bindings;
  }
  async putBinding(binding: ControllerBinding): Promise<void> {
    await this.records.state.write(
      `controller-resource-${binding.resourceId}.json`,
      controllerBindingSchema.parse(binding),
    );
  }
  async githubBinding(
    resourceId: string,
    identity: ControllerIdentity,
  ): Promise<ControllerGitHubBinding | null> {
    z.string().uuid().parse(resourceId);
    const binding = await this.records.state.read(
      `controller-github-${resourceId}.json`,
      githubBindingSchema.parse,
    );
    if (binding && !sameIdentity(binding, identity))
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "GitHub resource belongs to another paired controller authority.",
      );
    return binding;
  }
  async githubBindings(identity: ControllerIdentity): Promise<ControllerGitHubBinding[]> {
    const bindings: ControllerGitHubBinding[] = [];
    for (const key of await this.records.state.keys("controller-github-")) {
      const binding = await this.records.state.read(key, githubBindingSchema.parse);
      if (binding && sameIdentity(binding, identity)) bindings.push(binding);
    }
    return bindings;
  }
  /** Explicit reauthorization may retain the same physical device while advancing its epoch. */
  async githubBindingForAdoption(
    resourceId: string,
    identity: ControllerIdentity,
  ): Promise<ControllerGitHubBinding | null> {
    const binding = await this.records.state.read(
      `controller-github-${z.string().uuid().parse(resourceId)}.json`,
      githubBindingSchema.parse,
    );
    if (binding && (binding.userId !== identity.userId || binding.deviceId !== identity.deviceId))
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Explicit adoption cannot reparent another physical owner's journal.",
      );
    return binding;
  }
  async putGitHubBinding(
    binding: GitHubControllerResource,
    identity: ControllerIdentity,
  ): Promise<void> {
    await this.records.state.write(
      `controller-github-${binding.resourceId}.json`,
      githubBindingSchema.parse({ ...binding, ...identity }),
    );
  }
  /** Owner loss cannot turn an accepted SSH phase into proof of physical closure. */
  async requireGitHubCustodySettled(
    resourceId: string,
    activeRequestIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const key of await this.records.state.keys("controller-operation-")) {
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (
        !entry ||
        entry.resourceId !== resourceId ||
        entry.phase?.name !== "provision" ||
        activeRequestIds.has(entry.requestId)
      )
        continue;
      const outcome = entry.outcome as ControllerOperation["outcome"];
      if (
        entry.state === "accepted" ||
        (outcome?.ok === false && outcome.error.code === "LOCAL_CUSTODY_UNCONFIRMED")
      )
        throw new LocalRefusal(
          "LOCAL_CUSTODY_UNCONFIRMED",
          "Original provisioning process custody is unconfirmed; no new physical operation is admitted.",
        );
    }
  }
  async forSpace(space: LocalSpace, identity: ControllerIdentity): Promise<ControllerBinding> {
    const found = (await this.bindings(identity)).filter(
      (binding) =>
        binding.repositoryId === space.repositoryId &&
        binding.operationMarker === space.operationMarker &&
        (binding.localSpaceId === space.id ||
          (binding.localSpaceId === null && !binding.creationClosed && space.phase === "creating")),
    );
    if (found.length !== 1)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Native space has no unique current controller binding.",
      );
    return found[0];
  }
  async inspect(requestId: string, identity: ControllerIdentity): Promise<ControllerOperation> {
    controllerRequestIdSchema.parse(requestId);
    const entry = await this.records.state.read(
      `controller-operation-${requestId}.json`,
      operationSchema.parse,
    );
    if (!entry) return { requestId, state: "absent" };
    if (!sameIdentity(entry.identity, identity))
      throw new LocalRefusal("LOCAL_UNAUTHORIZED", "Operation belongs to another authority.");
    return {
      requestId,
      state:
        entry.state === "completed"
          ? "completed"
          : this.pending.has(requestId)
            ? "accepted"
            : "unconfirmed",
      ...(entry.outcome ? { outcome: entry.outcome as ControllerOperation["outcome"] } : {}),
    };
  }

  /** Read original admissions only; never wait for, replay or collect their effects. */
  async find(identity: ControllerIdentity, input: unknown) {
    const selection = controllerOperationFindSchema.parse(input);
    const operations = [];
    const keys = (await this.records.state.keys("controller-operation-")).sort();
    for (const key of keys) {
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (
        !entry ||
        !sameIdentity(entry.identity, identity) ||
        (selection.cursor && entry.requestId <= selection.cursor)
      )
        continue;
      const kind = entry.descriptor?.kind ?? "unknown";
      if (selection.kind && selection.kind !== kind) continue;
      if (
        selection.query &&
        !(entry.descriptor?.description ?? "Retained controller operation")
          .toLowerCase()
          .includes(selection.query.toLowerCase())
      )
        continue;
      operations.push({
        ...(await this.inspect(entry.requestId, identity)),
        kind,
        ...(entry.descriptor ? { descriptor: entry.descriptor } : {}),
      });
      if (operations.length === 50) return { operations, nextCursor: entry.requestId };
    }
    return { operations };
  }
  async recordPhase(
    requestId: string,
    identity: ControllerIdentity,
    phase: NonNullable<z.infer<typeof operationSchema>["phase"]>,
  ): Promise<void> {
    await this.serial(async () => {
      const key = `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`;
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (!entry || entry.state !== "accepted" || !sameIdentity(entry.identity, identity))
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "Only the original accepted owner operation may enter a physical phase.",
        );
      await this.records.state.write(key, operationSchema.parse({ ...entry, phase }));
    });
  }
  async originalProviderCreation(requestId: string, identity: ControllerIdentity) {
    const entry = await this.records.state.read(
      `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`,
      operationSchema.parse,
    );
    if (
      !entry ||
      !sameIdentity(entry.identity, identity) ||
      !entry.resourceId ||
      entry.phase?.name !== "provider_create" ||
      this.pending.has(requestId)
    )
      return null;
    return { resourceId: entry.resourceId, resourceGeneration: entry.phase.resourceGeneration };
  }
  async settleObservedCreation(requestId: string, identity: ControllerIdentity): Promise<void> {
    await this.serial(async () => {
      const key = `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`;
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (
        !entry ||
        !sameIdentity(entry.identity, identity) ||
        entry.phase?.name !== "provider_create" ||
        this.pending.has(requestId)
      )
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "The original creation is not available for observation.",
        );
      const prior = entry.outcome as ControllerOperation["outcome"];
      const diagnostic =
        prior?.ok === false && /^[A-Z][A-Z0-9_]{1,79}$/.test(prior.error.code)
          ? ` Original diagnostic: ${prior.error.code}.`
          : "";
      await this.records.state.write(key, {
        ...entry,
        state: "completed",
        originalOutcome: entry.originalOutcome ?? entry.outcome,
        outcome: {
          ok: false,
          error: {
            code: "GITHUB_PROVISIONING_INCOMPLETE",
            message:
              "The original provider resource was found; provisioning is incomplete. No creation, start or SSH was repeated. Explicitly adopt this resource to prepare it." +
              diagnostic,
            ...(prior?.ok === false && prior.error.providerFailure
              ? { providerFailure: prior.error.providerFailure }
              : {}),
          },
        },
      });
    });
  }
  async recordCustody(
    requestId: string,
    identity: ControllerIdentity,
    witness: ProcessCustodyWitness,
    securityRequestId: string,
  ): Promise<void> {
    await this.serial(async () => {
      const key = `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`;
      const entry = await this.records.state.read(key, operationSchema.parse);
      witness = processCustodyWitnessSchema.parse(witness);
      controllerRequestIdSchema.parse(securityRequestId);
      if (
        !entry ||
        entry.state !== "accepted" ||
        entry.phase?.name !== "provision" ||
        !sameIdentity(entry.identity, identity) ||
        (entry.custody && entry.custody.securityRequestId !== securityRequestId) ||
        witness.path !== `${this.records.state.root}/.custody-${witness.nonce}`
      )
        throw new LocalRefusal(
          "LOCAL_CUSTODY_UNCONFIRMED",
          "Provisioning custody differs from its original journal.",
        );
      const witnesses = entry.custody?.witnesses ?? [];
      if (witnesses.some((prior) => prior.nonce === witness.nonce))
        throw new LocalRefusal(
          "LOCAL_CUSTODY_UNCONFIRMED",
          "A physical process witness cannot be replaced or reused.",
        );
      await this.records.state.write(key, {
        ...entry,
        custody: { securityRequestId, witnesses: [...witnesses, witness] },
      });
    });
  }
  async custody(requestId: string, identity: ControllerIdentity) {
    const entry = await this.records.state.read(
      `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`,
      operationSchema.parse,
    );
    if (
      !entry ||
      !sameIdentity(entry.identity, identity) ||
      !entry.resourceId ||
      !entry.phase ||
      !entry.custody
    )
      return null;
    return {
      resourceId: entry.resourceId,
      resourceGeneration: entry.phase.resourceGeneration,
      ...entry.custody,
    };
  }
  async settleCustody(requestId: string, identity: ControllerIdentity): Promise<void> {
    await this.serial(async () => {
      const key = `controller-operation-${controllerRequestIdSchema.parse(requestId)}.json`;
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (
        !entry ||
        !sameIdentity(entry.identity, identity) ||
        !entry.custody ||
        this.pending.has(requestId)
      )
        throw new LocalRefusal(
          "LOCAL_CUSTODY_UNCONFIRMED",
          "The original physical operation is not available for closure.",
        );
      const prior = entry.outcome as ControllerOperation["outcome"];
      const diagnostic =
        prior?.ok === false && /^[A-Z][A-Z0-9_]{1,79}$/.test(prior.error.code)
          ? ` Original diagnostic: ${prior.error.code}.`
          : "";
      await this.records.state.write(key, {
        ...entry,
        state: "completed",
        originalOutcome: entry.originalOutcome ?? entry.outcome,
        outcome: {
          ok: false,
          error: {
            code: "GITHUB_PROVISIONING_INCOMPLETE",
            message:
              "Original host provisioning custody is closed; no GitHub action was repeated. Observe the resource before explicitly preparing it again." +
              diagnostic,
            securityRequestId: entry.custody.securityRequestId,
            ...(prior?.ok === false && prior.error.providerFailure
              ? { providerFailure: providerFailureSchema.parse(prior.error.providerFailure) }
              : {}),
          },
        },
      });
    });
  }
  async pendingResources(identity: ControllerIdentity): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const key of await this.records.state.keys("controller-operation-")) {
      const entry = await this.records.state.read(key, operationSchema.parse);
      if (!entry || !entry.resourceId || !sameIdentity(entry.identity, identity)) continue;
      if (entry.state === "completed") {
        const outcome = entry.outcome as ControllerOperation["outcome"];
        if (
          !outcome ||
          outcome.ok ||
          (![
            "WORKSPACE_OUTCOME_UNCONFIRMED",
            "WORKSPACE_OUTCOME_UNKNOWN",
            "LOCAL_CUSTODY_UNCONFIRMED",
          ].includes(outcome.error.code) &&
            scopedCredentialFailureOutcome(outcome.error.code) !== "unconfirmed")
        )
          continue;
      }
      const requests = result.get(entry.resourceId) ?? [];
      requests.push(entry.requestId);
      result.set(entry.resourceId, requests);
    }
    for (const requests of result.values()) requests.sort();
    return result;
  }
  async run(
    requestId: string,
    identity: ControllerIdentity,
    input: unknown,
    action: () => Promise<unknown>,
  ): Promise<ControllerOperation> {
    controllerRequestIdSchema.parse(requestId);
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const resource = z.object({ resourceId: z.string().uuid() }).passthrough().safeParse(input);
    const projection = resource.success ? { resourceId: resource.data.resourceId } : {};
    const intentAction = z
      .object({
        action: z.enum([
          "create",
          "start",
          "stop",
          "delete",
          "adopt",
          "resume_setup",
          "repository",
          "communication",
        ]),
      })
      .passthrough()
      .safeParse(input);
    let work: Promise<ControllerOperation> | undefined;
    await this.serial(async () => {
      const entry = await this.records.state.read(
        `controller-operation-${requestId}.json`,
        operationSchema.parse,
      );
      if (entry) {
        if (entry.digest !== digest || !sameIdentity(entry.identity, identity))
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Request identity cannot change its operation or authority.",
          );
        work = this.pending.get(requestId) ?? this.inspect(requestId, identity);
        return;
      }
      const intent = z
        .object({
          repositoryId: z.string().optional(),
          repositoryFullName: z
            .string()
            .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
            .optional(),
          repository: z
            .object({
              fullName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
            })
            .passthrough()
            .optional(),
          ref: z
            .string()
            .regex(/^[A-Za-z0-9._/-]{1,255}$/)
            .optional(),
        })
        .passthrough()
        .safeParse(input);
      const label = intent.success
        ? (intent.data.repositoryFullName ??
          intent.data.repository?.fullName ??
          (intent.data.repositoryId
            ? (await this.records.policyOrNull())?.repositories.find(
                (row) => row.id === intent.data.repositoryId,
              )?.fullName
            : undefined))
        : undefined;
      const descriptor = intentAction.success
        ? controllerOperationDescriptorSchema.parse({
            kind:
              intentAction.data.action === "repository"
                ? "repository"
                : intentAction.data.action === "communication"
                  ? "delivery"
                  : "lifecycle",
            description:
              (intentAction.data.action === "repository"
                ? "Admit repository"
                : intentAction.data.action === "communication"
                  ? "Deliver communication"
                  : `Workspace ${intentAction.data.action.replaceAll("_", " ")}`) +
              (label ? ` ${label}` : "") +
              (intent.success && intent.data.ref ? ` at ${intent.data.ref}` : ""),
            createdAt: Date.now(),
          })
        : undefined;
      await this.records.state.write(`controller-operation-${requestId}.json`, {
        requestId,
        digest,
        identity,
        ...projection,
        state: "accepted",
        ...(descriptor ? { descriptor } : {}),
      });
      work = Promise.resolve()
        .then(action)
        .then(
          (result) => ({ ok: true as const, result }),
          (error) => ({
            ok: false as const,
            error: {
              code: error instanceof LocalRefusal ? error.code : "LOCAL_CONTROLLER_FAILED",
              message:
                error instanceof LocalRefusal
                  ? error.message
                  : "Controller operation failed; inspect its original identity.",
              ...(error &&
              typeof error === "object" &&
              "providerFailure" in error &&
              providerFailureSchema.safeParse(error.providerFailure).success
                ? { providerFailure: providerFailureSchema.parse(error.providerFailure) }
                : {}),
              ...(error &&
              typeof error === "object" &&
              "securityRequestId" in error &&
              controllerRequestIdSchema.safeParse(error.securityRequestId).success
                ? { securityRequestId: error.securityRequestId }
                : {}),
            },
          }),
        )
        .then(async (outcome) => {
          try {
            const accepted = await this.records.state.read(
              `controller-operation-${requestId}.json`,
              operationSchema.parse,
            );
            await this.records.state.write(`controller-operation-${requestId}.json`, {
              requestId,
              digest,
              identity,
              ...projection,
              state: "completed",
              outcome,
              ...(accepted?.phase ? { phase: accepted.phase } : {}),
              ...(accepted?.custody ? { custody: accepted.custody } : {}),
              ...(accepted?.descriptor ? { descriptor: accepted.descriptor } : {}),
            });
          } catch {
            // The effect already ran. Publishing/fsync failure cannot become a refusal,
            // and an accepted record must never invoke the effect again.
            return { requestId, state: "unconfirmed" as const };
          }
          return { requestId, state: "completed" as const, outcome };
        })
        .finally(() => this.pending.delete(requestId));
      this.pending.set(requestId, work);
      void work.catch(() => undefined);
    });
    return work!;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
  async waitForOperation(
    requestId: string,
    identity: ControllerIdentity,
  ): Promise<ControllerOperation> {
    return this.pending.get(requestId) ?? this.inspect(requestId, identity);
  }
}
