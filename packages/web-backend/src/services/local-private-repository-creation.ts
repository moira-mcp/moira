import { z } from "zod";
import {
  LocalDeviceError,
  canonicalJson,
  digestLocalSecret,
  type RepositoryCreationRepository,
  type RepositoryCreationRecord,
  type RepositoryCreationAuthority,
} from "@mcp-moira/shared";
import {
  GitHubCodespaceClientError,
  type HttpGitHubCodespaceClient,
  type GitHubPrivateRepositoryIdentity,
} from "./github-codespace-client.js";
import type {
  LocalRepositoryAdmissionService,
  LocalRepositoryAdmissionResult,
} from "./local-repository-admission.js";

export const localPrivateRepositoryCreationInputSchema = z
  .object({
    deviceId: z.string().uuid(),
    requestId: z.string().uuid(),
    repositoryName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((name) => name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git")),
    installationId: z.string().regex(/^[1-9][0-9]{0,39}$/),
  })
  .strict();
type RepositorySetupStage =
  | "github_connection"
  | "device_delegation"
  | "authority_validation"
  | "repository_lookup"
  | "repository_create"
  | "installation_access"
  | "local_admission";

export interface LocalPrivateRepositoryCreationResult {
  status: "pending" | "applied" | "unknown" | "setup_required" | "rejected";
  device_id: string;
  request_id: string;
  github_repository_id: string | null;
  full_name: string | null;
  local_repository_id: string | null;
  error: {
    code: string;
    message: string;
    stage?: RepositorySetupStage;
    provider_status?: number;
  } | null;
  instruction: string;
  links: { settings: string; installation: string | null };
}
type Provider = Pick<
  HttpGitHubCodespaceClient,
  "inspectRepositoryByName" | "createPrivateRepository" | "addRepositoryToInstallation"
>;
export interface LocalPrivateRepositoryCreationDependencies {
  repository: RepositoryCreationRepository;
  admission: LocalRepositoryAdmissionService;
  authorize: (
    userId: string,
    installationId: string,
  ) => Promise<{
    authority: RepositoryCreationAuthority;
    accessToken: string;
    repositorySelection: "all" | "selected";
  }>;
  currentAuthority: (userId: string) => RepositoryCreationAuthority;
  provider: () => Provider;
  verifyInstallation: (
    userId: string,
    installationId: string,
    repositoryId: string,
  ) => Promise<void>;
  links: () => { settings: string; installation: string | null };
  now?: () => number;
}

/** One durable create; later calls inspect or finish installation/admission, never blindly repeat. */
export class LocalPrivateRepositoryCreationService {
  private readonly now: () => number;
  constructor(private readonly dependencies: LocalPrivateRepositoryCreationDependencies) {
    this.now = dependencies.now ?? Date.now;
  }
  private markerDescription(record: RepositoryCreationRecord): string {
    return `Created by Moira. Recovery marker: ${record.marker}`;
  }
  private matches(
    record: RepositoryCreationRecord,
    repository: GitHubPrivateRepositoryIdentity,
  ): boolean {
    return (
      repository.ownerId === record.githubUserId &&
      repository.ownerLogin.toLowerCase() === record.owner.toLowerCase() &&
      repository.fullName.toLowerCase() ===
        `${record.owner}/${record.repositoryName}`.toLowerCase() &&
      repository.private &&
      repository.description === this.markerDescription(record)
    );
  }
  private result(
    input: z.infer<typeof localPrivateRepositoryCreationInputSchema>,
    record: RepositoryCreationRecord | null,
    status: LocalPrivateRepositoryCreationResult["status"],
    code: string | null = null,
    admission?: LocalRepositoryAdmissionResult,
    setup?: { stage: RepositorySetupStage; providerStatus?: number },
  ): LocalPrivateRepositoryCreationResult {
    const setupInstructions: Record<RepositorySetupStage, string> = {
      github_connection:
        "Refresh the GitHub connection and selected personal App installation in Moira Settings, then resume this same request.",
      device_delegation:
        "Apply permission to create new private repositories on this local computer for the connected GitHub account and a valid work lease, then resume this same request.",
      authority_validation:
        "The saved repository request no longer matches the connected account or applied computer permission. Restore its original authority and resume this same request; do not create a replacement request.",
      repository_lookup:
        "GitHub refused the repository lookup. Check access for the selected App installation and resume this same request.",
      repository_create:
        "GitHub refused creation of the private repository. Check the App's Repository creation (write) or Administration (write) permission, accept updated permissions and refresh GitHub permissions in Moira Settings; resume this same request.",
      installation_access:
        "The repository has been retained, but App installation access is not confirmed. Add it to the selected installation; for selected repositories check GitHub App installation repository access (write). Refresh GitHub permissions and resume this same request without creating another repository.",
      local_admission:
        "The repository is retained, but its local access is not applied. Check the computer's permission request and companion acknowledgement, then resume this same request.",
    };
    const setupInstruction =
      setup?.providerStatus === 401
        ? "GitHub refused the stored authorization. Refresh GitHub permissions in Moira Settings, then resume this same request."
        : setup?.providerStatus === 429
          ? "GitHub is rate limiting this request. Wait for GitHub access to recover, then resume this same request without starting another creation."
          : setup
            ? setupInstructions[setup.stage]
            : null;
    const instruction =
      status === "applied"
        ? "Use local_repository_id with codespace create; each codespace receives its own VM."
        : status === "unknown"
          ? `${setupInstruction ? `${setupInstruction} ` : ""}The GitHub create outcome is unknown. Resume this exact request; Moira will inspect its recovery marker without repeating creation.${setup?.providerStatus === undefined ? "" : ` GitHub response: HTTP ${setup.providerStatus}.`}`
          : status === "setup_required"
            ? setup
              ? `${setupInstruction}${setup.providerStatus === undefined ? "" : ` GitHub response: HTTP ${setup.providerStatus}.`}`
              : "Check the connected GitHub account, selected App installation, required permissions, and applied device delegation in Moira Settings; resume the same request."
            : status === "rejected"
              ? setup?.stage === "local_admission"
                ? "The private repository is already created, but this computer's admission was rejected or superseded. Restore access to the already-created repository in Moira Settings, or use repository_add with its retained github_repository_id and a fresh request_id if the applied delegation permits existing repositories. Do not create another repository. After restoring the original grant, resume this same creation request."
                : "The request was refused; inspect its identity and owner delegation before starting another request."
              : "Resume the same request to inspect completion; companion acknowledgement is required before local access is available.";
    return {
      status,
      device_id: input.deviceId,
      request_id: input.requestId,
      github_repository_id: record?.repositoryId ?? null,
      full_name: record?.fullName ?? null,
      local_repository_id: status === "applied" ? (admission?.local_repository_id ?? null) : null,
      error: code
        ? {
            code,
            message: instruction,
            ...(setup ? { stage: setup.stage } : {}),
            ...(setup?.providerStatus === undefined
              ? {}
              : { provider_status: setup.providerStatus }),
          }
        : null,
      instruction,
      links: this.dependencies.links(),
    };
  }
  private current(
    record: RepositoryCreationRecord,
    admitted: RepositoryCreationAuthority,
  ): RepositoryCreationAuthority {
    const current = this.dependencies.currentAuthority(record.userId);
    if (canonicalJson(current) !== canonicalJson(admitted))
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "GitHub credentials changed before repository mutation.",
      );
    this.dependencies.repository.assertCurrent(record, current, this.now());
    return current;
  }
  async createRepository(
    userId: string,
    value: z.infer<typeof localPrivateRepositoryCreationInputSchema>,
  ): Promise<LocalPrivateRepositoryCreationResult> {
    const input = localPrivateRepositoryCreationInputSchema.parse(value);
    const ledger = this.dependencies.repository;
    let record = ledger.getOwned(userId, input.requestId);
    if (record && record.fingerprint !== digestLocalSecret(canonicalJson(input)))
      throw new LocalDeviceError("LOCAL_CONFLICT", "Repository creation request identity changed.");
    if (record?.state === "rejected")
      return this.result(input, record, "rejected", record.errorCode);
    let context: Awaited<ReturnType<LocalPrivateRepositoryCreationDependencies["authorize"]>>;
    let stage: RepositorySetupStage = "github_connection";
    try {
      context = await this.dependencies.authorize(userId, input.installationId);
      stage = "device_delegation";
      record = record ?? ledger.reserve(userId, input, context.authority, this.now());
      stage = "authority_validation";
      this.current(record, context.authority);
    } catch (error) {
      if (!(error instanceof LocalDeviceError) && !(error instanceof GitHubCodespaceClientError))
        throw error;
      if (error instanceof LocalDeviceError && error.code === "LOCAL_CAPACITY")
        return this.result(input, record, "rejected", "LOCAL_CAPACITY");
      return this.result(
        input,
        record,
        "setup_required",
        "LOCAL_GITHUB_SETUP_REQUIRED",
        undefined,
        {
          stage,
          ...(error instanceof GitHubCodespaceClientError ? { providerStatus: error.status } : {}),
        },
      );
    }
    const claimed = ledger.claim(userId, input.requestId, this.now());
    if (!claimed) return this.result(input, ledger.getOwned(userId, input.requestId), "pending");
    record = claimed;
    try {
      const provider = this.dependencies.provider();
      if (record.state === "prepared") {
        stage = "repository_lookup";
        const present = await provider.inspectRepositoryByName(
          context.accessToken,
          record.owner,
          record.repositoryName,
        );
        stage = "authority_validation";
        this.current(record, context.authority);
        if (present) {
          ledger.mark(record, "rejected", "LOCAL_REPOSITORY_NAME_EXISTS", this.now());
          return this.result(
            input,
            ledger.getOwned(userId, input.requestId),
            "rejected",
            "LOCAL_REPOSITORY_NAME_EXISTS",
          );
        }
        ledger.submit(record, this.current(record, context.authority), this.now());
        record = ledger.getOwned(userId, input.requestId)!;
        let created: GitHubPrivateRepositoryIdentity;
        try {
          stage = "repository_create";
          created = await provider.createPrivateRepository(context.accessToken, {
            name: record.repositoryName,
            description: this.markerDescription(record),
          });
        } catch (error) {
          if (
            error instanceof GitHubCodespaceClientError &&
            [400, 401, 403, 404, 409, 422, 429].includes(error.status)
          ) {
            const setup = [401, 403, 404, 429].includes(error.status);
            ledger.mark(
              record,
              setup ? "prepared" : "rejected",
              setup ? "LOCAL_GITHUB_SETUP_REQUIRED" : "LOCAL_REPOSITORY_CREATE_REJECTED",
              this.now(),
            );
            return this.result(
              input,
              ledger.getOwned(userId, input.requestId),
              setup ? "setup_required" : "rejected",
              setup ? "LOCAL_GITHUB_SETUP_REQUIRED" : "LOCAL_REPOSITORY_CREATE_REJECTED",
              undefined,
              { stage, providerStatus: error.status },
            );
          }
          ledger.mark(record, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN", this.now());
          return this.result(
            input,
            ledger.getOwned(userId, input.requestId),
            "unknown",
            "LOCAL_REPOSITORY_CREATE_UNKNOWN",
          );
        }
        if (!this.matches(record, created)) {
          ledger.mark(record, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN", this.now());
          return this.result(
            input,
            ledger.getOwned(userId, input.requestId),
            "unknown",
            "LOCAL_REPOSITORY_CREATE_UNKNOWN",
          );
        }
        ledger.recordCreated(record, created.id, created.fullName, this.now());
        record = ledger.getOwned(userId, input.requestId)!;
      } else if (record.state === "unknown" || record.state === "submitted") {
        stage = "repository_lookup";
        const observed = await provider.inspectRepositoryByName(
          context.accessToken,
          record.owner,
          record.repositoryName,
        );
        stage = "authority_validation";
        this.current(record, context.authority);
        if (!observed || !this.matches(record, observed)) {
          ledger.mark(record, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN", this.now());
          return this.result(
            input,
            ledger.getOwned(userId, input.requestId),
            "unknown",
            "LOCAL_REPOSITORY_CREATE_UNKNOWN",
          );
        }
        ledger.recordCreated(record, observed.id, observed.fullName, this.now());
        record = ledger.getOwned(userId, input.requestId)!;
      }
      this.current(record, context.authority);
      if (!record.installationVerified) {
        stage = "installation_access";
        if (context.repositorySelection === "selected")
          await provider.addRepositoryToInstallation(
            context.accessToken,
            input.installationId,
            record.repositoryId!,
          );
        this.current(record, context.authority);
        await this.dependencies.verifyInstallation(
          userId,
          input.installationId,
          record.repositoryId!,
        );
        // Refresh may legitimately rotate an expiring token; consent and pinned account still hold.
        ledger.assertCurrent(record, this.dependencies.currentAuthority(userId), this.now());
        ledger.confirmInstallation(record, this.now());
        record = ledger.getOwned(userId, input.requestId)!;
      }
      stage = "local_admission";
      const admission = await this.dependencies.admission.addCreatedRepository(
        userId,
        {
          deviceId: input.deviceId,
          requestId: record.admissionRequestId,
          repositoryId: record.repositoryId!,
        },
        input.requestId,
      );
      return this.result(
        input,
        ledger.getOwned(userId, input.requestId),
        admission.status,
        admission.error?.code ?? null,
        admission,
        { stage: "local_admission" },
      );
    } catch (error) {
      if (!(error instanceof LocalDeviceError) && !(error instanceof GitHubCodespaceClientError))
        throw error;
      const retained = ledger.getOwned(userId, input.requestId)!;
      if (retained.state === "submitted" || retained.state === "unknown") {
        ledger.mark(record, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN", this.now());
        return this.result(
          input,
          retained,
          "unknown",
          "LOCAL_REPOSITORY_CREATE_UNKNOWN",
          undefined,
          {
            stage,
            ...(error instanceof GitHubCodespaceClientError
              ? { providerStatus: error.status }
              : {}),
          },
        );
      }
      ledger.mark(record, retained.state, "LOCAL_GITHUB_SETUP_REQUIRED", this.now());
      return this.result(
        input,
        retained,
        "setup_required",
        "LOCAL_GITHUB_SETUP_REQUIRED",
        undefined,
        {
          stage,
          ...(error instanceof GitHubCodespaceClientError ? { providerStatus: error.status } : {}),
        },
      );
    } finally {
      ledger.releaseClaim(record, this.now());
    }
  }
}
