import type { IncomingMessage, ServerResponse } from "node:http";
export { readOwnerJsonBody as readOwnerPullRequestInput } from "./request-body.mjs";
export type GitHubOwnerAction = "fetch" | "push" | "pull_request_read" | "pull_request_create";
interface GitHubOwnerLeaseBase {
  repositoryFullName: string;
  dispose(): Promise<void>;
}
export type GitHubOwnerLease = GitHubOwnerLeaseBase &
  (
    | { mode: "anonymous"; useUntil: number | null }
    | {
        mode: "scoped";
        useUntil: number;
        token: string;
        credentialId: string;
        expiresAt: number;
        validate(signal?: AbortSignal): Promise<void>;
      }
  );
export interface GitHubOwnerAuthority {
  repositoryFullName: string;
  acquire(action: GitHubOwnerAction, signal?: AbortSignal): Promise<GitHubOwnerLease>;
  signal?: AbortSignal;
}
export interface OwnerPullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  title: string;
  head: string;
  base: string;
  draft: boolean;
}
export class GitHubOwnerError extends Error {
  constructor(publicCode: string, status?: number);
  publicCode: string;
  status: number;
  securityRequestId?: string;
}
export function validateOwnerPullRequestInput(
  action: string,
  input: unknown,
): Record<string, unknown>;
export function serveOwnerGit(
  request: IncomingMessage,
  response: ServerResponse,
  options: GitHubOwnerAuthority & { allowPush: boolean },
): Promise<void>;
export function ownerPullRequest(
  action: "pull_request_create" | "pull_request_get" | "pull_request_find",
  input: unknown,
  options: GitHubOwnerAuthority,
): Promise<OwnerPullRequest | OwnerPullRequest[]>;
