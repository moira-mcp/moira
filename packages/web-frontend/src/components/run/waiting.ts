/**
 * Who the run waits for, worded. A block is `waiting` whenever the run pauses on one of its
 * nodes; the projection says whether a person (a lock's PIN) or the agent (a step to complete)
 * is waited for, and only the person reads as "waiting for you".
 */

import type { TFunction } from "i18next";
import type { ExecutionBlockStatus } from "./model";

export type WaitingFor = "agent" | "user" | null;

/**
 * The key half that words the waiting state, for the places that keep their own waiting sentence
 * (`pages.runPage.status.*`, `pages.runPage.blockDetail.noContent.*`): `waiting` reads as a
 * person being waited for, `waitingAgent` as the agent. Only `waitingFor === "user"` is a person; an unknown
 * or absent actor is worded as the agent, because nothing then says a person must act.
 */
export function waitingSuffix(waitingFor: WaitingFor): "waiting" | "waitingAgent" {
  return waitingFor === "user" ? "waiting" : "waitingAgent";
}

/** The wording of the waiting state itself. */
export function waitingLabel(waitingFor: WaitingFor, t: TFunction): string {
  return t(`pages.runPage.status.${waitingSuffix(waitingFor)}`);
}

/** The wording of any block status; `waiting` depends on who is waited for. */
export function blockStatusLabel(
  status: ExecutionBlockStatus,
  waitingFor: WaitingFor,
  t: TFunction,
): string {
  return status === "waiting" ? waitingLabel(waitingFor, t) : t(`pages.runPage.status.${status}`);
}
