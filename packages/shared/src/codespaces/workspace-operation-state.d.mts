export function operationState(
  data?: {
    state?: string;
    reason?: unknown;
    error?: { code?: unknown };
    outcome?: { ok?: boolean; error?: { code?: unknown } };
  } | null,
): "absent" | "pending" | "unconfirmed" | "completed";
