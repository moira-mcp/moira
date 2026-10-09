/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "saas",
    features: {},
    loaded: true,
    error: false,
    retry: () => {},
    isEnabled: () => true,
  }),
}));
const { apiClient } = await import("../../../packages/web-frontend/src/services/api-client");
const { InviteAcceptPage } = await import("../../../packages/web-frontend/src/pages/InviteAccept");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { ROUTES } = await import("../../../packages/web-frontend/src/constants/routes");
const { revalidateReadSession, getReadIdentity } =
  await import("../../../packages/web-frontend/src/services/read-scope");
type AcceptedInvite = Awaited<ReturnType<typeof apiClient.acceptInvite>>;

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
function sessionFor(id: string) {
  return {
    user: { id, email: `${id}@example.test`, name: id, emailVerified: true },
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
let completions: Array<(result: AcceptedInvite) => void>;
let holdSessionReads: boolean;
let sessionReads: Array<{ aborted: boolean; finish: (response: Response) => void }>;
const accepted: AcceptedInvite = {
  accessId: "owner-a-access",
  workflowId: "owner-a-workflow",
  ownerHandle: "private-owner-a",
  slug: "accepted-flow",
  message: "Accepted",
};
const invitePath = "/invites/public-token";
const acceptedPath = `${ROUTES.WORKFLOWS}/${accepted.ownerHandle}/${accepted.slug}`;

beforeEach(async () => {
  jest.useFakeTimers();
  globalThis.React = React;
  await i18n.changeLanguage("en");
  session = sessionFor("owner-a");
  completions = [];
  holdSessionReads = false;
  sessionReads = [];
  jest.spyOn(apiClient, "getInviteInfo").mockResolvedValue({
    valid: true,
    expired: false,
    used: false,
    workflowName: "Public invite workflow",
    createdByHandle: "inviter",
    expiresAt: Date.UTC(2099, 0, 1),
    remainingMs: 100000,
  });
  jest
    .spyOn(apiClient, "acceptInvite")
    .mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) {
      if (!holdSessionReads) return Response.json(session);
      return new Promise<Response>((resolve, reject) => {
        const read = {
          aborted: false,
          finish: (response: Response) => {
            init?.signal?.removeEventListener("abort", abort);
            resolve(response);
          },
        };
        const abort = () => {
          read.aborted = true;
          reject(new DOMException("Session read canceled", "AbortError"));
        };
        sessionReads.push(read);
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }
    throw new Error(`Unexpected auth request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  holdSessionReads = false;
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
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <button onClick={() => navigate("/elsewhere")}>Leave invite</button>
    </>
  );
}
async function mountAndAccept() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[invitePath]}>
        <ReadScopeBoundary>
          <Routes>
            <Route path="/invites/:token" element={<InviteAcceptPage />} />
            <Route path="*" element={<div>Destination</div>} />
          </Routes>
          <Location />
        </ReadScopeBoundary>
      </MemoryRouter>
    </I18nextProvider>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByTestId("accept-invite-button"));
  expect(apiClient.acceptInvite).toHaveBeenCalledWith("public-token");
  expect(completions).toHaveLength(1);
}
async function replaceOwner() {
  session = sessionFor("owner-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
}

test("a previous-owner delayed invite acceptance cannot publish a success link or redirect the replacement account", async () => {
  await mountAndAccept();
  await replaceOwner();
  await act(async () => completions[0](accepted));
  expect(
    screen.queryByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toBeNull();
  expect(screen.queryByText(i18n.t("pages.inviteAccept.acceptSuccess"))).toBeNull();
  await act(async () => jest.advanceTimersByTime(2100));
  expect(screen.getByTestId("location")).toHaveTextContent(invitePath);
});

test("an already accepted previous-owner state and its scheduled redirect retire when the authoritative account changes", async () => {
  await mountAndAccept();
  await act(async () => completions[0](accepted));
  expect(
    screen.getByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toHaveAttribute("href", acceptedPath);
  await replaceOwner();
  expect(
    screen.queryByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toBeNull();
  expect(screen.queryByText(i18n.t("pages.inviteAccept.acceptSuccess"))).toBeNull();
  await act(async () => jest.advanceTimersByTime(2100));
  expect(screen.getByTestId("location")).toHaveTextContent(invitePath);
  expect(screen.getByText("Public invite workflow")).toBeVisible();
});

test("a current-owner acceptance still renders its workflow link and completes the normal delayed redirect", async () => {
  await mountAndAccept();
  await act(async () => completions[0](accepted));
  expect(
    screen.getByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toHaveAttribute("href", acceptedPath);
  await act(async () => jest.advanceTimersByTime(2100));
  expect(screen.getByTestId("location")).toHaveTextContent(acceptedPath);
});

test("a scheduled previous-owner invite redirect cannot navigate after account replacement", async () => {
  await mountAndAccept();
  await act(async () => completions[0](accepted));
  expect(
    screen.getByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toHaveAttribute("href", acceptedPath);
  await replaceOwner();
  // Check the delayed effect independently of the success-state assertions in other regressions.
  await act(async () => jest.advanceTimersByTime(2100));
  expect(screen.getByTestId("location")).toHaveTextContent(invitePath);
});

test("a pending acceptance can finish after authoritative confirmation of the same account with renewed credentials", async () => {
  await mountAndAccept();
  session = sessionFor("owner-a");
  session.session.id = "owner-a-renewed-session";
  session.session.token = "owner-a-renewed-token";
  await act(async () => authClient.$store.atoms.session.get().refetch());
  const requestsBeforeCompletion = jest.mocked(globalThis.fetch).mock.calls.length;
  await act(async () => completions[0](accepted));
  expect(jest.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(requestsBeforeCompletion);
  expect(
    screen.getByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
  ).toHaveAttribute("href", acceptedPath);
  await act(async () => jest.advanceTimersByTime(2100));
  expect(screen.getByTestId("location")).toHaveTextContent(acceptedPath);
});

async function settleSession(outcome: string) {
  if (outcome === "replacement") session = sessionFor("owner-b");
  if (outcome === "unmounted") fireEvent.click(screen.getByText("Leave invite"));
  holdSessionReads = false;
  await act(async () => {
    for (const read of sessionReads.filter((read) => !read.aborted))
      read.finish(
        outcome === "error"
          ? Response.json({ message: "Session check unavailable" }, { status: 500 })
          : Response.json(session),
      );
  });
}

test.each(["same owner", "replacement", "error", "unmounted"])(
  "accepted invite waits for the actual %s session after its refetch is canceled",
  async (outcome) => {
    await mountAndAccept();
    session = sessionFor("owner-a");
    session.session.id = "owner-a-renewed-session";
    await act(async () => authClient.$store.atoms.session.get().refetch());
    holdSessionReads = true;
    await act(async () => completions[0](accepted));
    const canceled = sessionReads.at(-1)!;
    expect(authClient.$store.atoms.session.get().isRefetching).toBe(true);
    await act(async () => revalidateReadSession());
    expect(canceled.aborted).toBe(true);
    expect(getReadIdentity()).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent(invitePath);
    await settleSession(outcome);
    if (outcome === "same owner")
      expect(
        screen.getByRole("link", { name: i18n.t("pages.inviteAccept.goToWorkflow") }),
      ).toHaveAttribute("href", acceptedPath);
    await act(async () => jest.advanceTimersByTime(2000));
    expect(screen.getByTestId("location").textContent).toBe(
      outcome === "same owner" ? acceptedPath : outcome === "unmounted" ? "/elsewhere" : invitePath,
    );
  },
);

test.each(["same owner", "replacement", "error", "unmounted"])(
  "a due invite redirect waits through a held %s session refresh",
  async (outcome) => {
    await mountAndAccept();
    await act(async () => completions[0](accepted));
    holdSessionReads = true;
    await act(async () => revalidateReadSession());
    await act(async () => jest.advanceTimersByTime(2000));
    expect(screen.getByTestId("location")).toHaveTextContent(invitePath);
    await settleSession(outcome);
    expect(screen.getByTestId("location").textContent).toBe(
      outcome === "same owner" ? acceptedPath : outcome === "unmounted" ? "/elsewhere" : invitePath,
    );
  },
);
