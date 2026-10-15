import { describe, expect, test } from "@jest/globals";
import type { CodespaceAvailableBillingView, CodespaceConnectionService } from "@mcp-moira/shared";
import { createCodespaceBillingReader } from "../../../packages/web-backend/src/services/codespace-services.js";

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
    });

    const oldRead = read("user");
    await firstEntered;
    generation = 2;
    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 2 } });
    finishFirst(billing);
    await expect(oldRead).resolves.toBe("unavailable");
    await expect(read("user")).resolves.toMatchObject({ compute: { used_core_hours: 2 } });
    expect(calls).toBe(3);
  });
});
