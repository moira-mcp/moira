import { afterEach, describe, expect, it } from "@jest/globals";

const originalMode = process.env.DEPLOYMENT_MODE;

describe("account admission", () => {
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    const { resetFeatureResolver } = await import("@mcp-moira/shared");
    resetFeatureResolver();
  });

  it("should keep approval state independent from whether the gate is required", async () => {
    const { getAccountAdmission, resetFeatureResolver } = await import("@mcp-moira/shared");

    process.env.DEPLOYMENT_MODE = "self-host";
    resetFeatureResolver();
    expect(getAccountAdmission(null, "pending")).toEqual({
      approvalRequired: true,
      approved: false,
      admitted: false,
    });
    expect(getAccountAdmission("2026-08-20T12:00:00.000Z", "approved")).toEqual({
      approvalRequired: true,
      approved: true,
      admitted: true,
    });

    process.env.DEPLOYMENT_MODE = "saas";
    resetFeatureResolver();
    expect(getAccountAdmission(null, "saas-user")).toEqual({
      approvalRequired: false,
      approved: false,
      admitted: true,
    });
  });

  it("should treat empty and missing timestamps as pending", async () => {
    process.env.DEPLOYMENT_MODE = "self-host";
    const { getAccountAdmission, resetFeatureResolver } = await import("@mcp-moira/shared");
    resetFeatureResolver();

    expect(getAccountAdmission("").approved).toBe(false);
    expect(getAccountAdmission(undefined).approved).toBe(false);
  });

  it("should apply blocked, approval, and email gates in security order", async () => {
    const { getAccountAccessDenial, resetFeatureResolver } = await import("@mcp-moira/shared");

    process.env.DEPLOYMENT_MODE = "self-host";
    resetFeatureResolver();
    expect(getAccountAccessDenial({ blocked: true, approvedAt: null, emailVerified: false })).toBe(
      "blocked",
    );
    expect(getAccountAccessDenial({ blocked: false, approvedAt: null, emailVerified: true })).toBe(
      "approval",
    );
    expect(
      getAccountAccessDenial(
        { blocked: false, approvedAt: null, emailVerified: false },
        { allowPendingApproval: true },
      ),
    ).toBeNull();
    expect(
      getAccountAccessDenial(
        {
          blocked: false,
          approvedAt: "2026-08-20T12:00:00.000Z",
          emailVerified: false,
        },
        { requireEmailVerified: true },
      ),
    ).toBeNull();

    process.env.DEPLOYMENT_MODE = "saas";
    resetFeatureResolver();
    expect(
      getAccountAccessDenial(
        { blocked: false, approvedAt: null, emailVerified: false },
        { requireEmailVerified: true },
      ),
    ).toBe("email-verification");
    expect(
      getAccountAccessDenial(
        { blocked: false, approvedAt: null, emailVerified: true },
        { requireEmailVerified: true },
      ),
    ).toBeNull();
  });
});
