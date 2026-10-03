/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

type AdmissionFacts = Awaited<
  ReturnType<
    (typeof import("../../../packages/web-frontend/src/services/api-client"))["apiClient"]["getUserInfo"]
  >
>;
let approvalMode = false;
const getUserInfo = jest.fn<() => Promise<AdmissionFacts>>();
jest.unstable_mockModule("../../../packages/web-frontend/src/services/api-client", () => ({
  apiClient: { getUserInfo },
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: approvalMode ? "self-host" : "saas",
    features: {},
    loaded: true,
    error: false,
    retry: () => {},
    isEnabled: (name: string) => name === "accountApproval" && approvalMode,
  }),
}));
const { RegistrationSuccess } =
  await import("../../../packages/web-frontend/src/pages/RegistrationSuccess");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
function sessionFor(id: string) {
  return {
    user: { id, email: `${id}@example.test`, name: id, emailVerified: false },
    session: {
      id: `${id}-session`,
      userId: id,
      token: `test-${id}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
let session: ReturnType<typeof sessionFor> | null;
let admissions: Array<(facts: AdmissionFacts) => void>;
let verifications: Array<(response: Response) => void>;
beforeEach(async () => {
  jest.useFakeTimers();
  globalThis.React = React;
  await i18n.changeLanguage("en");
  session = sessionFor("owner-a");
  admissions = [];
  verifications = [];
  getUserInfo.mockReset();
  getUserInfo.mockImplementation(() => new Promise((resolve) => admissions.push(resolve)));
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("disableCookieCache=true")) {
      return new Promise<Response>((resolve) => verifications.push(resolve));
    }
    if (url.includes("/get-session")) return Response.json(session);
    throw new Error(`Unexpected request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  session = null;
  await authClient.$store.atoms.session.get().refetch();
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}
function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/registration-success"]}>
        <ReadScopeBoundary>
          <Routes>
            <Route path="/registration-success" element={<RegistrationSuccess />} />
            <Route path="*" element={<div>Completed destination</div>} />
          </Routes>
          <Location />
        </ReadScopeBoundary>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

async function completeStatus(owner: NonNullable<typeof session>) {
  await act(async () => {
    if (approvalMode) {
      admissions[0]({
        id: owner.user.id,
        email: owner.user.email,
        handle: null,
        isAdmin: false,
        passwordResetRequired: false,
        blocked: false,
        emailVerified: false,
        approvedAt: "2026-01-01T00:00:00.000Z",
        accountApproved: true,
        accountApprovalRequired: true,
      });
    } else {
      verifications[0](Response.json({ ...owner, user: { ...owner.user, emailVerified: true } }));
    }
  });
}

test.each(["approval", "email-verification"])(
  "the current owner's successful %s completion still reaches its destination",
  async (mode) => {
    approvalMode = mode === "approval";
    mount();
    await act(async () => {});
    await completeStatus(session!);
    expect(screen.getByText(i18n.t("pages.registrationSuccess.redirecting"))).toBeVisible();
    await act(async () => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.getByText("Completed destination")).toBeVisible();
  },
);

test.each(["approval", "email-verification"])(
  "a late previous-owner %s completion cannot complete or redirect the replacement account",
  async (mode) => {
    approvalMode = mode === "approval";
    const previousSession = session!;
    mount();
    await act(async () => {});
    // Control the real page's current pending operation, not a substitute status renderer.
    const reply = approvalMode ? admissions[0] : verifications[0];
    expect(reply).toBeDefined();
    session = sessionFor("owner-b");
    await act(async () => authClient.$store.atoms.session.get().refetch());
    await completeStatus(previousSession);
    await act(async () => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId("location")).toHaveTextContent("/registration-success");
    expect(
      screen.getByText(
        i18n.t(
          approvalMode
            ? "pages.registrationSuccess.pendingTitle"
            : "pages.registrationSuccess.title",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByText(i18n.t("pages.registrationSuccess.redirecting"))).toBeNull();
  },
);
