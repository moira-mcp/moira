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

type LocalGitLease = Extract<GitHubOwnerLease, { mode: "scoped" }> & {
  validate(signal?: AbortSignal): Promise<void>;
};
type Acquire = (
  grant: BrokerGrant,
  action: GitHubOwnerAction,
  signal?: AbortSignal,
) => Promise<LocalGitLease>;

/** Host admission/custody adapter; fixed Git/PR execution and TLS belong to the common owner. */
export function gitBroker(
  budget: NetworkBudget,
  onFault: (error: unknown) => void,
  acquire: Acquire,
  operations = { git: serveOwnerGit, pullRequest: ownerPullRequest },
): Pick<BrokerOptions, "git" | "pullRequest"> {
  const run = async (
    request: IncomingMessage,
    response: ServerResponse,
    grant: BrokerGrant,
    work: (authority: GitHubOwnerAuthority) => Promise<void>,
  ) => {
    if (response.destroyed) return;
    const reservation = await budget.reserve(grant.policy, grant.admission);
    if (response.destroyed) {
      await reservation.release().catch(onFault);
      return;
    }
    const controller = new AbortController();
    const signal = grant.admission?.signal
      ? AbortSignal.any([grant.admission.signal, controller.signal])
      : controller.signal;
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
            useUntil: grant.policy.leaseUntil,
            dispose: async () => {},
          };
        return acquire(grant, action, admissionSignal);
      },
    };
    try {
      await work(authority);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
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
      await reservation.release().catch(onFault);
    }
  };
  return {
    git: (request, response, grant) =>
      run(request, response, grant, (authority) =>
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
      await run(request, response, grant, async (authority) => {
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
