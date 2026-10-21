import { scopedCredentialFailureOutcome } from "./scoped-credential-types.ts";

/** Project retained owner observations without collecting or changing their original receipts. */
export function operationState(data) {
  if (!data) return "unconfirmed";
  const codes = [data.error?.code, data.reason, data.outcome?.error?.code];
  if (
    codes.some(
      (code) =>
        scopedCredentialFailureOutcome(code) === "unconfirmed" ||
        [
          "WORKSPACE_OUTCOME_UNCONFIRMED",
          "WORKSPACE_OUTCOME_UNKNOWN",
          "OWNER_DELIVERY_UNCONFIRMED",
          "LOCAL_CUSTODY_UNCONFIRMED",
          "LOCAL_CREATE_UNKNOWN",
          "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
          "LOCAL_STOP_PENDING",
          "LOCAL_CONTROL_RELEASE_UNCONFIRMED",
          "LOCAL_OUTCOME_UNCONFIRMED",
          "LOCAL_ADMISSION_UNCONFIRMED",
        ].includes(code),
    )
  )
    return "unconfirmed";
  if (data.state === "absent") return "absent";
  if (["running", "starting", "accepted", "pending"].includes(data.state)) return "pending";
  if (["unknown", "unconfirmed", "outcome_unknown", "interrupted"].includes(data.state))
    return "unconfirmed";
  return data.state === undefined && !data.outcome ? "unconfirmed" : "completed";
}
