/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AuthUIProvider as LibraryProvider } from "@daveyplate/better-auth-ui";

type ProviderProps = React.ComponentProps<typeof LibraryProvider>;
let presentation: ProviderProps;
let hosted = true;

jest.unstable_mockModule("@daveyplate/better-auth-ui", () => ({
  AuthUIProvider: (props: ProviderProps) => {
    presentation = props;
    return <>{props.children}</>;
  },
  AuthView: () => <input aria-label="Draft" defaultValue="" />,
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/auth/better-auth-client", () => ({
  authClient: {},
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useAuthErrorHandler", () => ({
  useAuthErrorHandler: () => {},
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ isEnabled: () => hosted }),
}));
jest.unstable_mockModule("react-i18next", () => ({
  useTranslation: () => ({
    ready: true,
    t: (key: string, options?: { returnObjects?: boolean }) =>
      options?.returnObjects ? { SIGN_IN: "Localized sign in" } : key,
  }),
}));
jest.unstable_mockModule("sonner", () => ({
  Toaster: () => null,
  toast: { error: () => {} },
}));

const { AuthProvider, useAuthError, useAuthErrorSetter } =
  await import("../../../packages/web-frontend/src/auth/AuthProvider");
const { AuthForm } = await import("../../../packages/web-frontend/src/auth/AuthForm");
const { ROUTES, APP_PREFIX } = await import("../../../packages/web-frontend/src/constants/routes");

function ErrorState() {
  const { authError, clearAuthError } = useAuthError();
  return (
    <>
      <output data-testid="auth-error">{authError}</output>
      <button onClick={clearAuthError}>Clear error</button>
    </>
  );
}

function LocationState() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function ErrorControl() {
  const { setAuthError } = useAuthErrorSetter();
  return <button onClick={() => setAuthError("Rejected credentials")}>Reject</button>;
}

function mount(path: string, form = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        {form ? <AuthForm pathname={ROUTES.LOGIN} /> : <input aria-label="Draft" />}
        <ErrorState />
        <ErrorControl />
        <LocationState />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hosted = true;
});
afterEach(() => {
  const { result } = renderHook(useAuthError);
  act(() => result.current.clearAuthError());
  cleanup();
  jest.restoreAllMocks();
});

describe("auth presentation separated from global recovery", () => {
  test("a global error updates its subscriber without replacing a custom form or its draft", () => {
    mount(ROUTES.FORCED_PASSWORD_RESET, false);
    const input = screen.getByLabelText("Draft");
    fireEvent.change(input, { target: { value: "unsaved value" } });
    fireEvent.click(screen.getByText("Reject"));
    expect(screen.getByTestId("auth-error")).toHaveTextContent("Rejected credentials");
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("unsaved value");
  });

  test.each([true, false])(
    "hosted=%s retains legal and social configuration at the form boundary",
    (mode) => {
      hosted = mode;
      mount(ROUTES.REGISTER);
      expect(presentation.basePath).toBe(APP_PREFIX || "/");
      expect(presentation.viewPaths).toEqual({ SIGN_IN: "login", SIGN_UP: "register" });
      expect(presentation.localization).toEqual({ SIGN_IN: "Localized sign in" });
      expect(presentation.social).toEqual(mode ? { providers: ["github", "google"] } : undefined);
      expect(presentation.signUp).toEqual({
        fields: mode ? ["acceptedTermsAt", "acceptedNotRussianResidentAt"] : [],
      });
      expect(Object.keys(presentation.additionalFields ?? {})).toEqual(
        mode ? ["acceptedTermsAt", "acceptedNotRussianResidentAt"] : [],
      );
    },
  );

  test.each([
    [
      "?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=state",
      "?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=state",
    ],
    ["?returnUrl=%2Fnotes", "?returnUrl=%2Fnotes"],
    ["", ""],
  ])("registration preserves continuation %s instead of landing on login", (query, expected) => {
    mount(`${ROUTES.REGISTER}${query}`);
    act(() => presentation.navigate!(ROUTES.LOGIN));
    expect(screen.getByTestId("location")).toHaveTextContent(
      `${APP_PREFIX}/registration-success${expected}`,
    );
  });

  test("unverified re-registration redirects with OAuth continuation and leaves no auth error", () => {
    mount(
      `${ROUTES.REGISTER}?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback`,
    );
    jest.spyOn(console, "error").mockImplementation(() => {});
    act(() =>
      presentation.toast!({
        variant: "error",
        message: "Email not verified; request a new verification email",
      }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      `${APP_PREFIX}/registration-success?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback`,
    );
    expect(screen.getByTestId("auth-error")).toBeEmptyDOMElement();
  });

  test("a presentation error reaches the global store while the same input keeps its value", () => {
    mount(ROUTES.LOGIN);
    const input = screen.getByLabelText("Draft");
    fireEvent.change(input, { target: { value: "typed@example.com" } });
    jest.spyOn(console, "error").mockImplementation(() => {});
    act(() => presentation.toast!({ variant: "error", message: "Wrong password" }));
    expect(screen.getByTestId("auth-error")).toHaveTextContent("Wrong password");
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("typed@example.com");
  });
});
