import type { ReserveOperationResult } from "./operation-repository.js";
import type { CodespaceResourceRecord } from "./resource-types.js";

/**
 * The lifecycle authority an operation path borrows to wake a codespace it needs. It is the
 * resource service in the running system; the operation paths know nothing else about lifecycles.
 */
export interface CodespaceLifecycleStarter {
  /**
   * Return once the codespace is usable, or throw the bounded refusal that says why it is not: it
   * cannot be started at all, the provider is disabled, or it did not become usable within the
   * wait policy allows.
   */
  ensureRunning(userId: string, codespaceId: string): Promise<CodespaceResourceRecord>;
}

/**
 * Reserve an operation, starting the codespace once if it is merely asleep.
 *
 * A codespace idles out between two commands, which is ordinary rather than exceptional, so the
 * operation that needs it wakes it instead of handing the caller a refusal to act on. The start is
 * attempted once: if the codespace is still not usable afterwards the second reservation refuses
 * exactly as the first did, so nothing loops and no caller is woken into the same refusal twice.
 */
export async function startOnUse(
  reserve: () => ReserveOperationResult,
  lifecycle: CodespaceLifecycleStarter | undefined,
  target: { userId: string; codespaceId: string },
): Promise<ReserveOperationResult> {
  const reservation = reserve();
  if (reservation.outcome !== "not_running" || !lifecycle) return reservation;
  await lifecycle.ensureRunning(target.userId, target.codespaceId);
  return reserve();
}
