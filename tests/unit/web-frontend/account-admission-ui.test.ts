import {
  decideAdmissionRoute,
  getRegistrationCompletionMode,
} from "../../../packages/web-frontend/src/auth/admission-routing";

describe("account admission browser routing", () => {
  test("pending approval wins over an independently verified email", () => {
    expect(
      decideAdmissionRoute({
        accountApprovalRequired: true,
        accountApproved: false,
        emailVerificationGate: false,
        emailVerified: true,
      }),
    ).toBe("pending-approval");
  });

  test("self-host does not treat an unverified email as pending approval", () => {
    expect(
      decideAdmissionRoute({
        accountApprovalRequired: true,
        accountApproved: true,
        emailVerificationGate: false,
        emailVerified: false,
      }),
    ).toBe("allow");
  });

  test("SaaS retains its independent email-verification gate", () => {
    expect(
      decideAdmissionRoute({
        accountApprovalRequired: false,
        accountApproved: true,
        emailVerificationGate: true,
        emailVerified: false,
      }),
    ).toBe("verify-email");
  });

  test("fully admitted users can enter protected routes", () => {
    expect(
      decideAdmissionRoute({
        accountApprovalRequired: true,
        accountApproved: true,
        emailVerificationGate: true,
        emailVerified: true,
      }),
    ).toBe("allow");
  });
});

describe("registration completion content", () => {
  test("waits for capabilities before selecting content", () => {
    expect(getRegistrationCompletionMode(false, false)).toBe("loading");
  });

  test("selects administrator approval only when that capability is enabled", () => {
    expect(getRegistrationCompletionMode(true, true)).toBe("approval");
    expect(getRegistrationCompletionMode(true, false)).toBe("email-verification");
  });
});
