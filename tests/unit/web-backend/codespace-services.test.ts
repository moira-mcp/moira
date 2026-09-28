import { afterEach, describe, expect, test } from "@jest/globals";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodespaceAvailableBillingView, CodespaceConnectionService } from "@mcp-moira/shared";
import {
  createCodespaceBillingReader,
  migrateCodespaceTransferRoot,
} from "../../../packages/web-backend/src/services/codespace-services.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moira-codespace-transfer-root-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codespace transfer-root migration", () => {
  test("moves a legacy root and merges non-conflicting objects without losing bytes", () => {
    const movedParent = temporaryDirectory();
    const legacy = join(movedParent, "workspace-transfers");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "legacy-object"), "legacy-bytes");

    const moved = migrateCodespaceTransferRoot(movedParent);

    expect(moved).toBe(join(movedParent, "codespace-transfers"));
    expect(readFileSync(join(moved, "legacy-object"), "utf8")).toBe("legacy-bytes");
    expect(existsSync(legacy)).toBe(false);

    const mergedParent = temporaryDirectory();
    const mergedLegacy = join(mergedParent, "workspace-transfers");
    const current = join(mergedParent, "codespace-transfers");
    mkdirSync(mergedLegacy);
    mkdirSync(current);
    writeFileSync(join(mergedLegacy, "old-object"), "old-bytes");
    writeFileSync(join(current, "new-object"), "new-bytes");

    expect(migrateCodespaceTransferRoot(mergedParent)).toBe(current);
    expect(readFileSync(join(current, "old-object"), "utf8")).toBe("old-bytes");
    expect(readFileSync(join(current, "new-object"), "utf8")).toBe("new-bytes");
    expect(existsSync(mergedLegacy)).toBe(false);
  });

  test("fails before overwriting an object that exists in both roots", () => {
    const parent = temporaryDirectory();
    const legacy = join(parent, "workspace-transfers");
    const current = join(parent, "codespace-transfers");
    mkdirSync(legacy);
    mkdirSync(current);
    writeFileSync(join(legacy, "same-object"), "legacy-bytes");
    writeFileSync(join(current, "same-object"), "current-bytes");

    expect(() => migrateCodespaceTransferRoot(parent)).toThrow(/same-object/);
    expect(readFileSync(join(legacy, "same-object"), "utf8")).toBe("legacy-bytes");
    expect(readFileSync(join(current, "same-object"), "utf8")).toBe("current-bytes");
  });
});

describe("personal Codespaces billing reader", () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const billing: CodespaceAvailableBillingView = {
    state: "available",
    payer_login: "alice",
    period: { year: 2026, month: 9 },
    retrieved_at: now,
    plan: "free",
    compute: { used_core_hours: 2, included_core_hours: 120, net_amount_usd: 0 },
    storage: { used_gb_month: 1, included_gb_month: 15, net_amount_usd: 0 },
    net_amount_usd: 0,
  };
  const connection = {
    getStatus: () => ({ state: "connected", account: { id: "1", login: "alice" } }),
    getAccessToken: async () => "ghu_test",
  } as unknown as Pick<CodespaceConnectionService, "getStatus" | "getAccessToken">;

  test("a failed forced read invalidates the last successful summary", async () => {
    let calls = 0;
    const read = createCodespaceBillingReader({
      connection,
      authorization: () => ({ accountId: "1", credentialGeneration: 1, status: "connected" }),
      client: {
        getMonthlyBilling: async () => {
          calls += 1;
          if (calls === 1) return billing;
          throw new Error("GitHub denied Plan: read");
        },
      },
      now: () => now,
    });

    await expect(read("user")).resolves.toEqual(billing);
    await expect(read("user", { force: true })).resolves.toBe("unavailable");
    await expect(read("user")).resolves.toBe("unavailable");
    expect(calls).toBe(3);
  });

  test("reconnecting the same account with a new credential generation does not reuse billing", async () => {
    let generation = 1;
    let calls = 0;
    const read = createCodespaceBillingReader({
      connection,
      authorization: () => ({
        accountId: "1",
        credentialGeneration: generation,
        status: "connected",
      }),
      client: {
        getMonthlyBilling: async () => {
          calls += 1;
          return { ...billing, compute: { ...billing.compute, used_core_hours: calls } };
        },
      },
      now: () => now,
    });

    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 1 } });
    generation = 2;
    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 2 } });
    expect(calls).toBe(2);
  });

  test("an older in-flight response cannot replace the current authorization's billing", async () => {
    let generation = 1;
    let calls = 0;
    let enteredFirst!: () => void;
    let finishFirst!: (value: CodespaceAvailableBillingView) => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstResponse = new Promise<CodespaceAvailableBillingView>((resolve) => {
      finishFirst = resolve;
    });
    const read = createCodespaceBillingReader({
      connection,
      authorization: () => ({
        accountId: "1",
        credentialGeneration: generation,
        status: "connected",
      }),
      client: {
        getMonthlyBilling: async () => {
          calls += 1;
          if (calls === 1) {
            enteredFirst();
            return firstResponse;
          }
          return { ...billing, compute: { ...billing.compute, used_core_hours: 2 } };
        },
      },
      now: () => now,
    });

    const oldRead = read("user");
    await firstEntered;
    generation = 2;
    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 2 } });
    finishFirst(billing);
    await expect(oldRead).resolves.toBe("unavailable");
    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 2 } });
    expect(calls).toBe(2);
  });
});
