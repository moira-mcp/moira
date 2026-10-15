import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { LocalRecords, requireSpaceGrant } from "./space-record.js";
import { ControllerState } from "./controller-state.js";
import {
  controllerIdentitySchema,
  controllerResourceRegistrationSchema,
  githubControllerResourceSchema,
  githubProviderActionSchema,
  githubResourceAuthoritySchema,
  githubProvisionProofSchema,
  workspaceBootstrapCredentialSchema,
  providerFailureSchema,
  type ControllerResourceRegistration,
  type GitHubProviderAction,
  type GitHubResourceAuthority,
  type GitHubProvisionProof,
  type WorkspaceBootstrapCredential,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import { LocalRefusal } from "./policy.js";
import { inspectProcessCustody, type ProcessCustodyWitness } from "./process-custody.js";
import {
  scopedCredentialViewSchema,
  scopedCredentialCollectionSchema,
  scopedCredentialFailureOutcome,
  type ScopedCredentialAction,
  type ScopedCredentialAcquire,
  type ScopedCredentialView,
} from "../../shared/src/codespaces/scoped-credential-types.js";
import type { GitHubOwnerLease } from "../../workspace-service/src/github-owner.mjs";
import {
  prepareCredentialRequest,
  inspectCredentialRequest,
  updateCredentialRequest,
  type CredentialRequestStore,
  type CredentialRequestRecord,
} from "../../workspace-service/src/credential-request.mjs";

const uuid = z.string().uuid();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const localConnectionSchema = z
  .object({
    origin: z.string().url(),
    credential: secret,
    deviceId: uuid,
    label: z.string().min(1).max(80).optional(),
    userId: z.string().min(1).optional(),
    deviceGeneration: z.number().int().positive().optional(),
    connectionId: uuid.optional(),
    pairingId: uuid,
    pairingToken: secret.optional(),
    authorityRefused: z.boolean().optional(),
  })
  .strict();
type Connection = z.infer<typeof localConnectionSchema>;
const deviceSchema = controllerIdentitySchema
  .extend({ status: z.enum(["pending", "active", "revoked"]) })
  .passthrough();
export function relayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new LocalRefusal(
      "LOCAL_ORIGIN_UNSAFE",
      "Choose a fixed HTTPS Moira origin without credentials.",
    );
  return url.href.replace(/\/$/, "");
}
export class LocalDeviceAuthorityFailure extends LocalRefusal {
  constructor(code: string) {
    super(code, "Moira refused the confirmed device authority.");
  }
}
/** This private issuer boundary alone can distinguish custody uncertainty from refusal. */
export class LocalScopedCredentialFailure extends LocalRefusal {
  readonly outcome: "unconfirmed" | "refused";
  constructor(code: string) {
    const outcome = scopedCredentialFailureOutcome(code) === "refused" ? "refused" : "unconfirmed";
    super(
      code,
      outcome === "unconfirmed"
        ? "The scoped Git credential outcome is unconfirmed; inspect the original security request before repeating issuance."
        : "The scoped Git credential request was refused.",
    );
    this.outcome = outcome;
  }
}

/** Pairing and credential authority only; no queue, lifecycle dispatch or result forwarding. */
export class LocalRelay {
  constructor(
    readonly records: LocalRecords,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    private readonly inspectCustody: typeof inspectProcessCustody = inspectProcessCustody,
  ) {}
  isUnavailable(error: unknown): boolean {
    return error instanceof LocalRefusal && error.code === "LOCAL_RELAY_UNAVAILABLE";
  }
  private async json(
    connection: Connection,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    namespace: "device" | "scoped" | "github" = "device",
  ): Promise<unknown> {
    let response: Response;
    try {
      const prefix =
        namespace === "device"
          ? "/api/local-devices"
          : namespace === "scoped"
            ? "/api/codespaces/github/credentials"
            : "/api/codespaces/github/resources";
      response = await this.fetch(`${relayOrigin(connection.origin)}${prefix}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${connection.credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (namespace === "scoped")
        throw new LocalScopedCredentialFailure("WORKSPACE_OUTCOME_UNCONFIRMED");
      if (namespace === "github")
        throw new LocalRefusal(
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "The original provider request outcome is unconfirmed; collect before repeating it.",
        );
      throw new LocalRefusal("LOCAL_RELAY_UNAVAILABLE", "Device authority service is unavailable.");
    }
    if (!response.ok) {
      if (namespace === "github") {
        const failed = (await response.json().catch(() => null)) as {
          error?: { code?: unknown; providerFailure?: unknown };
        } | null;
        const code = failed?.error?.code;
        const evidence = providerFailureSchema.safeParse(failed?.error?.providerFailure);
        throw Object.assign(
          new LocalRefusal(
            response.status >= 500
              ? "WORKSPACE_OUTCOME_UNCONFIRMED"
              : typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
                ? code
                : "CODESPACE_AUTHORIZATION_REQUIRED",
            response.status >= 500
              ? "The original provider request outcome is unconfirmed; collect before repeating it."
              : "The assigned provider authority refused this request.",
          ),
          evidence.success ? { providerFailure: evidence.data } : {},
        );
      }
      if (namespace === "scoped") {
        const failed = (await response.json().catch(() => null)) as {
          error?: { code?: unknown };
        } | null;
        const code = failed?.error?.code;
        const known =
          typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : undefined;
        throw new LocalScopedCredentialFailure(known ?? "WORKSPACE_OUTCOME_UNCONFIRMED");
      }
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new LocalDeviceAuthorityFailure("LOCAL_UNAUTHORIZED");
      if (response.status < 500)
        throw new LocalRefusal(
          "LOCAL_RELAY_REFUSED",
          "Device authority service refused this request.",
        );
      throw new LocalRefusal(
        "LOCAL_RELAY_UNAVAILABLE",
        "Device authority service refused this observation.",
      );
    }
    if (namespace === "scoped" || namespace === "github") {
      try {
        return await response.json();
      } catch {
        if (namespace === "scoped")
          throw new LocalScopedCredentialFailure("WORKSPACE_OUTCOME_UNCONFIRMED");
        throw new LocalRefusal(
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "The original provider response could not be confirmed.",
        );
      }
    }
    const value = z
      .object({ success: z.literal(true), data: z.unknown() })
      .passthrough()
      .parse(await response.json());
    return value.data;
  }
  async enroll(origin: string, pairingId: string, pairingToken: string, label = hostname()) {
    const release = await this.records.state.lock();
    try {
      const identity = (await this.records.deviceIdentity()) ?? {
        deviceId: randomUUID(),
        label: z.string().min(1).max(80).parse(label),
      };
      let connection = await this.records.state.read(
        "connection.json",
        localConnectionSchema.parse,
      );
      if (
        connection &&
        (connection.origin !== relayOrigin(origin) ||
          connection.pairingId !== pairingId ||
          connection.deviceId !== identity.deviceId ||
          connection.pairingToken !== pairingToken ||
          connection.connectionId)
      )
        throw new LocalRefusal(
          "LOCAL_ALREADY_ENROLLED",
          "This device already retains another pairing identity.",
        );
      connection ??= localConnectionSchema.parse({
        origin: relayOrigin(origin),
        pairingId,
        pairingToken,
        deviceId: identity.deviceId,
        label: identity.label,
        credential: randomBytes(32).toString("base64url"),
      });
      await this.records.state.write("connection.json", connection);
      const device = deviceSchema.parse(
        await this.json(connection, "/enroll", {
          pairingId,
          pairingToken,
          credential: connection.credential,
          deviceId: identity.deviceId,
          label: identity.label,
        }),
      );
      if (device.deviceId !== identity.deviceId || device.status === "revoked")
        throw new LocalDeviceAuthorityFailure("LOCAL_IDENTITY_CHANGED");
      return { deviceId: device.deviceId, status: device.status };
    } finally {
      await release();
    }
  }
  async confirmed(
    signal?: AbortSignal,
  ): Promise<Connection & z.infer<typeof controllerIdentitySchema>> {
    const connection = await this.records.state.read(
      "connection.json",
      localConnectionSchema.parse,
    );
    if (!connection) throw new LocalRefusal("LOCAL_NOT_ENROLLED", "Pair this controller first.");
    if (connection.deviceId !== (await this.records.deviceIdentity())?.deviceId)
      throw new LocalDeviceAuthorityFailure("LOCAL_IDENTITY_CHANGED");
    if (!connection.connectionId) {
      if (!connection.pairingToken)
        throw new LocalRefusal(
          "LOCAL_PAIRING_INCOMPLETE",
          "Pending pairing has no owner confirmation.",
        );
      const status = z
        .object({ device: deviceSchema.nullable() })
        .passthrough()
        .parse(
          await this.json(
            connection,
            "/pairings/status",
            { pairingId: connection.pairingId, pairingToken: connection.pairingToken },
            signal,
          ),
        );
      if (!status.device || status.device.status !== "active")
        throw new LocalRefusal(
          "LOCAL_PAIRING_INCOMPLETE",
          "Confirm this device in Moira Settings.",
        );
      Object.assign(connection, controllerIdentitySchema.parse(status.device));
      delete connection.pairingToken;
      await this.records.state.write("connection.json", connection);
    }
    const expected = controllerIdentitySchema.parse(connection);
    const current = deviceSchema.parse(await this.json(connection, "/heartbeat", {}, signal));
    if (
      current.status !== "active" ||
      !(["userId", "deviceId", "deviceGeneration", "connectionId"] as const).every(
        (key) => current[key] === expected[key],
      )
    )
      throw new LocalDeviceAuthorityFailure("LOCAL_IDENTITY_CHANGED");
    if (connection.authorityRefused) {
      delete connection.authorityRefused;
      await this.records.state.write("connection.json", connection);
    }
    return { ...connection, ...expected };
  }
  async gitAuthority(spaceId: string, repositoryId: string, signal?: AbortSignal) {
    const connection = await this.confirmed(signal);
    const space = await this.records.get(spaceId);
    if (
      !space ||
      space.repositoryId !== repositoryId ||
      !space.runtimeId ||
      space.desiredState !== "running"
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Git requires its original locally admitted native space.",
      );
    requireSpaceGrant(await this.records.policy(), space, Date.now());
    const state = new ControllerState(this.records);
    await state.importBindings(connection);
    const binding = await state.forSpace(space, connection);
    return {
      origin: connection.origin,
      credential: connection.credential,
      resourceId: binding.resourceId,
      resourceGeneration: binding.routeGeneration ?? binding.resourceGeneration,
    };
  }
  async registerResource(
    input: ControllerResourceRegistration,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = controllerResourceRegistrationSchema.parse(input);
    const connection = await this.confirmed(signal);
    z.object({
      resourceId: z.literal(value.resourceId),
      repositoryId: z.literal(value.repositoryId),
      resourceGeneration: z.literal(value.resourceGeneration),
    })
      .strict()
      .parse(await this.json(connection, "/resources/register", value, signal));
  }
  async githubAssignment(resourceId: string, signal?: AbortSignal, purpose?: "adopt" | "retire") {
    uuid.parse(resourceId);
    const connection = await this.confirmed(signal);
    return githubControllerResourceSchema.parse(
      await this.json(
        connection,
        `/${resourceId}/assignment${purpose ? `?purpose=${purpose}` : ""}`,
        undefined,
        signal,
        "github",
      ),
    );
  }
  async registerGitHubResource(
    resourceId: string,
    input: GitHubResourceAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    uuid.parse(resourceId);
    const connection = await this.confirmed(signal);
    await this.json(
      connection,
      `/${resourceId}/register`,
      githubResourceAuthoritySchema.parse(input),
      signal,
      "github",
    );
  }
  async githubProvider(
    resourceId: string,
    input: GitHubProviderAction,
    signal?: AbortSignal,
  ): Promise<unknown> {
    uuid.parse(resourceId);
    const connection = await this.confirmed(signal);
    return this.json(
      connection,
      `/${resourceId}/provider`,
      githubProviderActionSchema.parse(input),
      signal,
      "github",
    );
  }
  async acquireProvisionCredential(
    resourceId: string,
    resourceGeneration: number,
    signal?: AbortSignal,
  ) {
    return this.acquireCredential(
      "codespaces_provision",
      async (checkSignal) => {
        const connection = await this.confirmed(checkSignal);
        const binding = await new ControllerState(this.records).githubBinding(
          resourceId,
          connection,
        );
        if (
          !binding ||
          binding.resourceGeneration !== resourceGeneration ||
          binding.desiredState !== "running"
        )
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The admitted provisioning authority changed.",
          );
        return { resourceId, resourceGeneration };
      },
      signal,
    );
  }
  async enrollGitHubWorkspace(resourceId: string, proof: GitHubProvisionProof) {
    uuid.parse(resourceId);
    const connection = await this.confirmed();
    const credential = workspaceBootstrapCredentialSchema.parse(
      await this.json(
        connection,
        `/${resourceId}/enroll`,
        githubProvisionProofSchema.parse(proof),
        undefined,
        "github",
      ),
    );
    this.validateWorkspaceCredential(connection, credential, resourceId, proof.environmentIdentity);
    if (
      credential.resourceGeneration !== proof.resourceGeneration ||
      credential.authorizationGeneration !== proof.authorizationGeneration
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Workspace enrollment returned another authority generation.",
      );
    return credential;
  }
  private validateWorkspaceCredential(
    connection: Connection,
    credential: WorkspaceBootstrapCredential,
    resourceId: string,
    environmentIdentity: string,
  ) {
    const publicOrigin = new URL(credential.publicOrigin);
    if (
      credential.origin !== relayOrigin(connection.origin) ||
      credential.resourceId !== resourceId ||
      credential.environmentIdentity !== environmentIdentity ||
      publicOrigin.protocol !== "https:" ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.search ||
      publicOrigin.hash ||
      publicOrigin.origin !== new URL(connection.origin).origin
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Workspace enrollment differs from its verified origin and physical identity.",
      );
  }
  private credentialRequests(): CredentialRequestStore {
    return {
      read: (requestId) =>
        this.records.state.read(`credential-request-${requestId}.json`, (value) => value),
      write: (requestId, record) =>
        this.records.state.write(`credential-request-${requestId}.json`, record),
    };
  }
  async pendingGitCredentialRequests(): Promise<CredentialRequestRecord[]> {
    const store = this.credentialRequests(),
      records: CredentialRequestRecord[] = [];
    for (const key of await this.records.state.keys("credential-request-")) {
      const record = await inspectCredentialRequest(
        store,
        key.slice("credential-request-".length, -".json".length),
      );
      if (record && !["disposed", "absent", "refused"].includes(record.state)) records.push(record);
    }
    return records;
  }
  /** Called only after the exclusive runner lock proves the prior physical owner is absent. */
  async markOrphanedGitCredentials(): Promise<void> {
    for (const record of await this.pendingGitCredentialRequests()) {
      // Local native-owner absence cannot attest a separate GitHub SSH process group.
      if (record.state === "live" && record.action !== "codespaces_provision")
        await updateCredentialRequest(
          this.credentialRequests(),
          record.requestId,
          "dispose_pending",
          record.credentialId,
        );
    }
  }
  private async disposeGitCredential(
    connection: Connection,
    input: ScopedCredentialAcquire,
    credentialId: string,
  ) {
    const store = this.credentialRequests();
    // A local receipt write failure must not prevent disposal of a known external capability.
    await updateCredentialRequest(store, input.requestId, "dispose_pending", credentialId).catch(
      () => undefined,
    );
    await this.json(
      connection,
      `/${credentialId}/release`,
      {
        resourceId: input.resourceId,
        resourceGeneration: input.resourceGeneration,
      },
      undefined,
      "scoped",
    );
    await updateCredentialRequest(store, input.requestId, "disposed", credentialId);
  }
  /** Recovery observes only this original security request, never resumes Git/PR or issuance. */
  async collectGitCredentialRequest(requestId: string): Promise<CredentialRequestRecord | null> {
    return this.collectCredentialRequest(requestId, false);
  }
  async collectProvisionCredential(
    requestId: string,
    proof: { resourceId: string; resourceGeneration: number; witnesses: ProcessCustodyWitness[] },
  ): Promise<CredentialRequestRecord | null> {
    const record = await inspectCredentialRequest(this.credentialRequests(), requestId);
    if (
      !record ||
      record.action !== "codespaces_provision" ||
      record.resourceId !== proof.resourceId ||
      record.resourceGeneration !== proof.resourceGeneration ||
      !proof.witnesses.length
    )
      throw new LocalRefusal(
        "LOCAL_CUSTODY_UNCONFIRMED",
        "Original provisioning credential and physical witnesses do not match.",
      );
    for (const witness of proof.witnesses)
      if ((await this.inspectCustody(witness)) !== "settled")
        throw new LocalRefusal(
          "LOCAL_CUSTODY_UNCONFIRMED",
          "The original host process remains unconfirmed.",
        );
    return this.collectCredentialRequest(requestId, true);
  }
  private async collectCredentialRequest(
    requestId: string,
    releaseLive: boolean,
  ): Promise<CredentialRequestRecord | null> {
    const store = this.credentialRequests(),
      record = await inspectCredentialRequest(store, requestId);
    if (
      !record ||
      ["disposed", "absent", "refused"].includes(record.state) ||
      (record.state === "live" && !releaseLive)
    )
      return record;
    const connection = await this.records.state.read(
      "connection.json",
      localConnectionSchema.parse,
    );
    if (!connection)
      throw new LocalRefusal("LOCAL_NOT_ENROLLED", "The original issuer binding is unavailable.");
    const input = {
      requestId,
      resourceId: record.resourceId,
      resourceGeneration: record.resourceGeneration,
      action: record.action,
    };
    const observed = scopedCredentialCollectionSchema.parse(
      await this.json(connection, `/requests/${requestId}`, input, undefined, "scoped"),
    );
    if (observed.state === "live") {
      await this.disposeGitCredential(connection, input, observed.credential.credentialId);
      return inspectCredentialRequest(store, requestId);
    }
    return updateCredentialRequest(store, requestId, observed.state);
  }
  /** Host-only scoped custody. Its original security request never becomes a guest credential. */
  async acquireGitCredential(
    spaceId: string,
    repositoryId: string,
    action: ScopedCredentialAction,
    signal?: AbortSignal,
  ): Promise<
    Extract<GitHubOwnerLease, { mode: "scoped" }> & {
      securityRequestId: string;
      validate(signal?: AbortSignal): Promise<void>;
    }
  > {
    return this.acquireCredential(
      action,
      (checkSignal) => this.gitAuthority(spaceId, repositoryId, checkSignal),
      signal,
    );
  }
  /** One security receipt/issuer path; provider-specific authority stays with its owner. */
  private async acquireCredential(
    action: ScopedCredentialAction,
    authorize: (
      signal?: AbortSignal,
    ) => Promise<{ resourceId: string; resourceGeneration: number }>,
    signal?: AbortSignal,
  ): Promise<
    Extract<GitHubOwnerLease, { mode: "scoped" }> & {
      securityRequestId: string;
      validate(signal?: AbortSignal): Promise<void>;
    }
  > {
    const authority = await authorize(signal);
    const connection = await this.confirmed(signal);
    const store = this.credentialRequests();
    const record = await prepareCredentialRequest(store, {
      resourceId: authority.resourceId,
      resourceGeneration: authority.resourceGeneration,
      action,
    });
    const input = {
      requestId: record.requestId,
      resourceId: record.resourceId,
      resourceGeneration: record.resourceGeneration,
      action: record.action,
    };
    let child: ScopedCredentialView;
    try {
      child = scopedCredentialViewSchema.parse(
        await this.json(connection, "/acquire", input, signal, "scoped"),
      );
    } catch (error) {
      const unconfirmed =
        !(error instanceof LocalRefusal) ||
        scopedCredentialFailureOutcome(error.code) !== "refused";
      await updateCredentialRequest(
        store,
        input.requestId,
        unconfirmed ? "unconfirmed" : "refused",
      ).catch(() => undefined);
      const refusal =
        error instanceof LocalRefusal
          ? error
          : new LocalRefusal(
              "WORKSPACE_OUTCOME_UNCONFIRMED",
              "The original security request must be collected before repeating issuance.",
            );
      throw Object.assign(refusal, { securityRequestId: input.requestId });
    }
    try {
      await updateCredentialRequest(store, input.requestId, "live", child.credentialId);
    } catch {
      await this.disposeGitCredential(connection, input, child.credentialId).catch(() => undefined);
      throw Object.assign(
        new LocalRefusal(
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "The security receipt could not be confirmed; collect its original request before repeating issuance.",
        ),
        { securityRequestId: input.requestId },
      );
    }
    return {
      mode: "scoped",
      securityRequestId: input.requestId,
      ...child,
      validate: async (checkSignal) => {
        const current = await authorize(checkSignal);
        if (
          current.resourceId !== input.resourceId ||
          current.resourceGeneration !== input.resourceGeneration
        )
          throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The Git resource authority changed.");
        const collection = scopedCredentialCollectionSchema.parse(
          await this.json(connection, `/requests/${input.requestId}`, input, checkSignal, "scoped"),
        );
        if (collection.state !== "live")
          throw new LocalRefusal(
            "SCOPED_CREDENTIAL_AUTHORITY_REFUSED",
            "The original scoped credential is no longer live.",
          );
        const observed = collection.credential;
        if (
          observed.credentialId !== child.credentialId ||
          observed.token !== child.token ||
          observed.repositoryFullName !== child.repositoryFullName ||
          observed.useUntil !== child.useUntil ||
          observed.expiresAt !== child.expiresAt
        )
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "The scoped Git credential authority changed.",
          );
      },
      // Disposal uses its captured authenticated binding even after physical work/lease is stopped.
      dispose: async () => {
        try {
          await this.disposeGitCredential(connection, input, child.credentialId);
        } catch {
          throw Object.assign(
            new LocalRefusal(
              "WORKSPACE_OUTCOME_UNCONFIRMED",
              "The scoped credential disposal is unconfirmed; collect its original security request.",
            ),
            { securityRequestId: input.requestId },
          );
        }
      },
    };
  }
  async gitIdentity(spaceId: string, repositoryId: string, signal?: AbortSignal) {
    const authority = await this.gitAuthority(spaceId, repositoryId, signal);
    const connection = await this.confirmed(signal);
    return z
      .object({ name: z.string().min(1), email: z.string().email() })
      .strict()
      .parse(
        await this.json(
          connection,
          `/github/${authority.resourceId}/${authority.resourceGeneration}/identity`,
          undefined,
          signal,
        ),
      );
  }
  async workspaceCredential(
    spaceId: string,
    repositoryId: string,
    environmentIdentity: string,
    signal?: AbortSignal,
  ) {
    const authority = await this.gitAuthority(spaceId, repositoryId, signal);
    const connection = await this.confirmed(signal);
    const credential = workspaceBootstrapCredentialSchema.parse(
      await this.json(
        connection,
        "/workspaces/bootstrap",
        { resourceId: authority.resourceId, environmentIdentity },
        signal,
      ),
    );
    this.validateWorkspaceCredential(
      connection,
      credential,
      authority.resourceId,
      environmentIdentity,
    );
    return credential;
  }
}
