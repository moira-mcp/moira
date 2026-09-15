import type { ReserveOperationResult } from "./operation-repository.js";
import type { WorkspaceResourceRecord } from "./resource-types.js";

/**
 * The lifecycle authority an operation path borrows to wake a workspace it needs. It is the
 * resource service in the running system; the operation paths know nothing else about lifecycles.
 */
export interface WorkspaceLifecycleStarter {
  /**
   * Return once the workspace is usable, or throw the bounded refusal that says why it is not: it
   * cannot be started at all, the provider is disabled, or it did not become usable within the
   * wait policy allows.
   */
  ensureRunning(userId: string, workspaceId: string): Promise<WorkspaceResourceRecord>;
}

/**
 * Reserve an operation, starting the workspace once if it is merely asleep.
 *
 * A workspace idles out between two commands, which is ordinary rather than exceptional, so the
 * operation that needs it wakes it instead of handing the caller a refusal to act on. The start is
 * attempted once: if the workspace is still not usable afterwards the second reservation refuses
 * exactly as the first did, so nothing loops and no caller is woken into the same refusal twice.
 */
export async function startOnUse(
  reserve: () => ReserveOperationResult,
  lifecycle: WorkspaceLifecycleStarter | undefined,
  target: { userId: string; workspaceId: string },
): Promise<ReserveOperationResult> {
  const reservation = reserve();
  if (reservation.outcome !== "not_running" || !lifecycle) return reservation;
  await lifecycle.ensureRunning(target.userId, target.workspaceId);
  return reserve();
}
