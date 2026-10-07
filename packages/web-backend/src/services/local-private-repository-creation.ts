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
export interface LocalPrivateRepositoryCreationResult {
  status: "pending" | "applied" | "unknown" | "setup_required" | "rejected";
  device_id: string;
  request_id: string;
  github_repository_id: string | null;
  full_name: string | null;
  local_repository_id: string | null;
  error: { code: string; message: string } | null;
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
  ): LocalPrivateRepositoryCreationResult {
    const instruction =
      status === "applied"
        ? "Use local_repository_id with codespace create; each codespace receives its own VM."
        : status === "unknown"
          ? "The GitHub create outcome is unknown. Resume this exact request; Moira will inspect its recovery marker without repeating creation."
          : status === "setup_required"
            ? "Check the connected GitHub account, selected App installation, required permissions, and applied device delegation in Moira Settings; resume the same request."
            : status === "rejected"
              ? "The request was refused; inspect its identity and owner delegation before starting another request."
              : "Resume the same request to inspect completion; companion acknowledgement is required before local access is available.";
    return {
      status,
      device_id: input.deviceId,
      request_id: input.requestId,
      github_repository_id: record?.repositoryId ?? null,
      full_name: record?.fullName ?? null,
      local_repository_id: status === "applied" ? (admission?.local_repository_id ?? null) : null,
      error: code ? { code, message: instruction } : null,
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
    try {
      context = await this.dependencies.authorize(userId, input.installationId);
      record = record ?? ledger.reserve(userId, input, context.authority, this.now());
      this.current(record, context.authority);
    } catch (error) {
      if (!(error instanceof LocalDeviceError) && !(error instanceof GitHubCodespaceClientError))
        throw error;
      if (error instanceof LocalDeviceError && error.code === "LOCAL_CAPACITY")
        return this.result(input, record, "rejected", "LOCAL_CAPACITY");
      return this.result(input, record, "setup_required", "LOCAL_GITHUB_SETUP_REQUIRED");
    }
    const claimed = ledger.claim(userId, input.requestId, this.now());
    if (!claimed) return this.result(input, ledger.getOwned(userId, input.requestId), "pending");
    record = claimed;
    try {
      const provider = this.dependencies.provider();
      if (record.state === "prepared") {
        const present = await provider.inspectRepositoryByName(
          context.accessToken,
          record.owner,
          record.repositoryName,
        );
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
        const observed = await provider.inspectRepositoryByName(
          context.accessToken,
          record.owner,
          record.repositoryName,
        );
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
      );
    } catch (error) {
      if (!(error instanceof LocalDeviceError) && !(error instanceof GitHubCodespaceClientError))
        throw error;
      const retained = ledger.getOwned(userId, input.requestId)!;
      if (retained.state === "submitted" || retained.state === "unknown") {
        ledger.mark(record, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN", this.now());
        return this.result(input, retained, "unknown", "LOCAL_REPOSITORY_CREATE_UNKNOWN");
      }
      ledger.mark(record, retained.state, "LOCAL_GITHUB_SETUP_REQUIRED", this.now());
      return this.result(input, retained, "setup_required", "LOCAL_GITHUB_SETUP_REQUIRED");
    } finally {
      ledger.releaseClaim(record, this.now());
    }
  }
}
