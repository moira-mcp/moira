/** The live transport's keepalive and authority observation cadence, not an operation deadline. */
export const WORKSPACE_HEARTBEAT_INTERVAL_MS = 20_000;
/** Maximum DATA rendezvous admission after a call is offered; never a command/stream deadline. */
export const WORKSPACE_RENDEZVOUS_TIMEOUT_MS = 20_000;
export const WORKSPACE_UPGRADE = "moira-workspace/2";
export type WorkspaceEndpointKind = "workspace" | "controller";
