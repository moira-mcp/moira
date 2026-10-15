/** Active workspace identities are disjoint from archived cloud-operation UUIDs. */
export const WORKSPACE_REQUEST_ID_PATTERN =
  /^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createWorkspaceRequestId() {
  return `ws1-${globalThis.crypto.randomUUID()}`;
}

export function workspaceRequestUuid(requestId) {
  if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId))
    throw new Error("INVALID_WORKSPACE_REQUEST_ID");
  return requestId.slice(4);
}
