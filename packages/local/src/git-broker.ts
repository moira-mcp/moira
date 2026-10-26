import type { IncomingMessage, ServerResponse } from "node:http";
import {
  serveOwnerGit,
  ownerPullRequest,
  readOwnerPullRequestInput,
  GitHubOwnerError,
  type GitHubOwnerAction,
  type GitHubOwnerAuthority,
  type GitHubOwnerLease,
} from "../../workspace-service/src/github-owner.mjs";
import type { BrokerGrant, BrokerOptions } from "./broker.js";
import { NetworkBudget } from "./network-budget.js";
import { LocalRefusal } from "./policy.js";
import { LocalScopedCredentialFailure } from "./relay.js";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.js";
import {
  LOCAL_SETUP_HEADER,
  type LocalSetupDiagnostic,
} from "../../shared/src/codespaces/local-protocol.js";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.js";

type LocalGitLease = Extract<GitHubOwnerLease, { mode: "scoped" }> & {
  validate(signal?: AbortSignal): Promise<void>;
};
type Acquire = (
  grant: BrokerGrant,
  action: GitHubOwnerAction,
  signal?: AbortSignal,
  setupRequestId?: string,
) => Promise<LocalGitLease>;

/** Host admission/custody adapter; fixed Git/PR execution and TLS belong to the common owner. */
export function gitBroker(
  budget: NetworkBudget,
  onFault: (error: unknown) => void,
  acquire: Acquire,
  operations = { git: serveOwnerGit, pullRequest: ownerPullRequest },
  setup?: {
    authorize(grant: BrokerGrant, requestId: string): Promise<void>;
    outcome(grant: BrokerGrant, requestId: string, diagnostic: LocalSetupDiagnostic): Promise<void>;
  },
): Pick<BrokerOptions, "git" | "pullRequest"> & {
  settleSetupRequests(spaceId: string, requestId: string): Promise<void>;
} {
  const requests = new Map<string, Set<Promise<void>>>();
  const key = (spaceId: string, requestId: string) => JSON.stringify([spaceId, requestId]);
  const run = async (
    request: IncomingMessage,
    response: ServerResponse,
    grant: BrokerGrant,
    work: (authority: GitHubOwnerAuthority) => Promise<void>,
  ) => {
    if (response.destroyed) return;
    let reservation: Awaited<ReturnType<NetworkBudget["reserve"]>> | undefined;
    let waitingForNetwork = false;
    const controller = new AbortController();
    const signal = grant.admission?.signal
      ? AbortSignal.any([grant.admission.signal, controller.signal])
      : controller.signal;
    let setupRequestId: string | undefined;
    let setupAuthorized = false;
    try {
      const marker = request.headers[LOCAL_SETUP_HEADER];
      if (marker !== undefined) {
        if (typeof marker !== "string" || !WORKSPACE_REQUEST_ID_PATTERN.test(marker) || !setup)
          throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The fixed setup marker is invalid.");
        await setup.authorize(grant, marker);
        setupRequestId = marker;
        setupAuthorized = true;
      }
      waitingForNetwork = true;
      reservation = await budget.reserve(grant.policy, grant.admission);
      waitingForNetwork = false;
      if (response.destroyed) return;
      const authority: GitHubOwnerAuthority = {
        repositoryFullName: grant.repository.fullName,
        signal,
        acquire: async (action, admissionSignal) => {
          if (
            (action === "push" && !grant.repository.allowPush) ||
            (action === "pull_request_create" && grant.repository.allowPullRequests !== true)
          )
            throw new LocalRefusal(
              "LOCAL_REPOSITORY_DENIED",
              "This repository action is not approved.",
            );
          if (
            action === "fetch" &&
            !grant.repository.private &&
            !grant.repository.allowPush &&
            grant.repository.allowPullRequests !== true
          )
            return {
              mode: "anonymous",
              repositoryFullName: grant.repository.fullName,
              useUntil: null,
              dispose: async () => {},
            };
          return acquire(grant, action, admissionSignal, setupRequestId);
        },
      };
      await work(authority);
    } catch (error) {
      // Preserve the broker's existing network-capacity status and refusal path.
      if (waitingForNetwork) throw error;
      const publicCode =
        error instanceof GitHubOwnerError
          ? error.publicCode
          : error instanceof LocalRefusal && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
            ? error.code
            : "CODESPACE_PROVIDER_UNAVAILABLE";
      const uncertain =
        publicCode === "WORKSPACE_OUTCOME_UNCONFIRMED" ||
        publicCode === "WORKSPACE_OUTCOME_UNKNOWN" ||
        scopedCredentialFailureOutcome(publicCode) === "unconfirmed" ||
        (error instanceof LocalScopedCredentialFailure && error.outcome === "unconfirmed");
      if (setupAuthorized && setupRequestId)
        await setup!
          .outcome(grant, setupRequestId, {
            code: publicCode,
            outcome: uncertain
              ? "unconfirmed"
              : /UNAVAILABLE|NOT_ENROLLED/.test(publicCode)
                ? "unavailable"
                : "refused",
          })
          .catch(onFault);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const securityRequestId =
        error &&
        typeof error === "object" &&
        "securityRequestId" in error &&
        typeof error.securityRequestId === "string" &&
        /^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          error.securityRequestId,
        )
          ? error.securityRequestId
          : undefined;
      response.writeHead(uncertain ? 503 : error instanceof GitHubOwnerError ? error.status : 403, {
        "content-type": "application/json",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(
        JSON.stringify({
          error: {
            code: publicCode,
            ...(securityRequestId ? { security_request_id: securityRequestId } : {}),
            message: uncertain
              ? "The GitHub outcome is unconfirmed. Inspect the original owner request before repeating a mutation."
              : "The approved GitHub operation is unavailable or refused.",
          },
        }),
      );
    } finally {
      controller.abort();
      await reservation?.release().catch(onFault);
    }
  };
  const tracked = (
    request: IncomingMessage,
    response: ServerResponse,
    grant: BrokerGrant,
    work: (authority: GitHubOwnerAuthority) => Promise<void>,
  ) => {
    const marker = request.headers[LOCAL_SETUP_HEADER];
    const scope =
      grant.spaceId && typeof marker === "string" && WORKSPACE_REQUEST_ID_PATTERN.test(marker)
        ? key(grant.spaceId, marker)
        : undefined;
    const pending = run(request, response, grant, work);
    if (scope) {
      const active = requests.get(scope) ?? new Set<Promise<void>>();
      active.add(pending);
      requests.set(scope, active);
      void pending
        .finally(() => {
          active.delete(pending);
          if (!active.size && requests.get(scope) === active) requests.delete(scope);
        })
        .catch(onFault);
    }
    return pending;
  };
  return {
    async settleSetupRequests(spaceId, requestId) {
      const scope = key(spaceId, requestId);
      while (requests.get(scope)?.size) await Promise.allSettled([...requests.get(scope)!]);
    },
    git: (request, response, grant) =>
      tracked(request, response, grant, (authority) =>
        operations.git(request, response, { ...authority, allowPush: grant.repository.allowPush }),
      ),
    pullRequest: async (request, response, grant) => {
      const match = /^\/github\/(pull_request_create|pull_request_get|pull_request_find)$/.exec(
        request.url ?? "",
      );
      if (!match || request.method !== "POST") {
        response.writeHead(403, { connection: "close" }).end();
        return;
      }
      await tracked(request, response, grant, async (authority) => {
        const action = match[1] as "pull_request_create" | "pull_request_get" | "pull_request_find";
        const result = await operations.pullRequest(
          action,
          await readOwnerPullRequestInput(request),
          authority,
        );
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          connection: "close",
        });
        response.end(
          JSON.stringify(
            action === "pull_request_find" ? { pull_requests: result } : { pull_request: result },
          ),
        );
      });
    },
  };
}
