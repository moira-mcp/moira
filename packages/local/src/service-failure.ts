import { z } from "zod";
import { LocalRefusal } from "./policy.js";
import type { PrivateState } from "./private-state.js";

const serviceFailureSchema = z
  .object({
    release: z.string().regex(/^[a-f0-9]{64}$/),
    code: z.string().regex(/^LOCAL_[A-Z_]+$/),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ServiceFailure = z.infer<typeof serviceFailureSchema>;

export function serviceFailure(state: PrivateState): Promise<ServiceFailure | null> {
  return state.read("service-failure.json", serviceFailureSchema.parse);
}

/** Unrelated owner failures cannot acknowledge a known authentication prerequisite. */
export async function recordServiceFailure(
  state: PrivateState,
  failure: ServiceFailure,
): Promise<void> {
  if ((await serviceFailure(state))?.code === "LOCAL_DOCKER_LOGIN_REQUIRED") return;
  await state.write("service-failure.json", serviceFailureSchema.parse(failure));
}

/** A retained authentication refusal is not permission to reopen a credential store. */
export async function requireNativeAdmission(state: PrivateState): Promise<void> {
  if ((await serviceFailure(state))?.code === "LOCAL_DOCKER_LOGIN_REQUIRED")
    throw new LocalRefusal(
      "LOCAL_DOCKER_LOGIN_REQUIRED",
      "Native Docker authentication requires explicit maintenance pause, same-store login and resume; controller communication remains available.",
    );
}

/** The caller owns the runner lock and has completed sign-in to the same credential store. */
export async function clearAuthenticatedFailure(
  state: PrivateState,
  observed: ServiceFailure | null,
): Promise<void> {
  if (observed?.code !== "LOCAL_DOCKER_LOGIN_REQUIRED") return;
  const current = await serviceFailure(state);
  if (
    current?.release === observed.release &&
    current.code === observed.code &&
    current.at === observed.at
  )
    await state.remove("service-failure.json");
}
