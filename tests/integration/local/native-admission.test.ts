import { expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import {
  serviceFailure,
  requireNativeAdmission,
  clearAuthenticatedFailure,
} from "../../../packages/local/src/service-failure.js";
import { localFixture } from "./fixtures.js";

const authenticationFailure = {
  release: "a".repeat(64),
  code: "LOCAL_DOCKER_LOGIN_REQUIRED",
  at: 123,
};

test("retained authentication failure refuses native restoration before storage or credential access", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-native-fence-")));
  const state = await PrivateState.open(root);
  const local = await localFixture(state);
  const forbidden = async () => {
    throw new Error("Native startup was entered despite the saved authentication failure");
  };
  const manager = new LocalManager(local.records, { storage: forbidden, guard: forbidden });
  try {
    await state.write("service-failure.json", authenticationFailure);
    await expect(manager.open()).rejects.toMatchObject({ code: "LOCAL_DOCKER_LOGIN_REQUIRED" });
    await expect(manager.restoreIntendedWork()).rejects.toMatchObject({
      code: "LOCAL_DOCKER_LOGIN_REQUIRED",
    });
    expect(await local.records.get(local.space.id)).toEqual(local.space);
    expect(await serviceFailure(state)).toEqual(authenticationFailure);
  } finally {
    await manager.release();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "failed native open retains exclusion already owned by its controller (%s)",
  async (preheldGate) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "moira-native-open-")));
    const state = await PrivateState.open(root);
    const local = await localFixture(state);
    const manager = new LocalManager(local.records, {
      storage: async () => {
        throw new LocalRefusal("LOCAL_DOCKER_LOGIN_REQUIRED", "Controlled native refusal");
      },
    });
    try {
      if (preheldGate) await manager.holdRunnerLock();
      await expect(manager.open()).rejects.toMatchObject({
        code: "LOCAL_DOCKER_LOGIN_REQUIRED",
      });
      if (preheldGate)
        await expect(state.lock({ recoverStale: true })).rejects.toMatchObject({
          code: "LOCAL_ALREADY_RUNNING",
        });
      else {
        const unlock = await state.lock({ recoverStale: true });
        await unlock();
      }
      await manager.release();
      const unlock = await state.lock({ recoverStale: true });
      await unlock();
      expect((await local.records.get(local.space.id))?.desiredState).toBe("running");
    } finally {
      await manager.release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("same-store authentication recovery clears its exact failure without erasing newer or unrelated failure evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-auth-recovery-")));
  const state = await PrivateState.open(root);
  const unlock = await state.lock();
  try {
    await state.write("service-failure.json", authenticationFailure);
    const observed = await serviceFailure(state);
    const newer = { ...authenticationFailure, at: 124 };
    await state.write("service-failure.json", newer);
    await clearAuthenticatedFailure(state, observed);
    expect(await serviceFailure(state)).toEqual(newer);
    await clearAuthenticatedFailure(state, await serviceFailure(state));
    expect(await serviceFailure(state)).toBeNull();
    await expect(requireNativeAdmission(state)).resolves.toBeUndefined();
    const unrelated = { ...authenticationFailure, code: "LOCAL_STOP_PENDING" };
    await state.write("service-failure.json", unrelated);
    await clearAuthenticatedFailure(state, await serviceFailure(state));
    expect(await serviceFailure(state)).toEqual(unrelated);
  } finally {
    await unlock();
    await rm(root, { recursive: true, force: true });
  }
});
