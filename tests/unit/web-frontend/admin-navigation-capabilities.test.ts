import {
  filterNavRoutes,
  type NavRoute,
} from "../../../packages/web-frontend/src/components/layout/AppSidebar";
import type { FeatureFlag } from "../../../packages/web-frontend/src/types/api-types";

const routes: NavRoute[] = [
  { path: "/admin", label: "Dashboard", icon: "home" },
  { path: "/admin/users", label: "Users", icon: "users", capability: "userManagement" },
  {
    path: "/admin/executions",
    label: "Executions",
    icon: "runs",
    capability: "multiUserAdmin",
  },
  {
    path: "/admin/operational",
    label: "Operational",
    icon: "ops",
    capability: "adminOperations",
  },
];

function capabilities(overrides: Partial<Record<FeatureFlag, boolean>>) {
  return {
    openRegistration: false,
    accountApproval: false,
    emailVerificationGate: false,
    verificationEmailOnSignup: false,
    legalConsents: false,
    betaNotices: false,
    multiUserAdmin: false,
    userManagement: false,
    adminAnalytics: false,
    adminOperations: false,
    operationsDevelopment: false,
    socialLogin: false,
    ...overrides,
  };
}

describe("admin navigation capabilities", () => {
  test("self-host exposes Users without exposing broader multi-user operations", () => {
    expect(
      filterNavRoutes(routes, true, capabilities({ userManagement: true })).map(
        (route) => route.path,
      ),
    ).toEqual(["/admin", "/admin/users"]);
  });

  test("SaaS retains both user and broader multi-user navigation", () => {
    expect(
      filterNavRoutes(
        routes,
        true,
        capabilities({ userManagement: true, multiUserAdmin: true, adminOperations: true }),
      ).map((route) => route.path),
    ).toEqual(["/admin", "/admin/users", "/admin/executions", "/admin/operational"]);
  });

  test("a disabled Users capability removes the route independently", () => {
    expect(
      filterNavRoutes(routes, true, capabilities({ multiUserAdmin: true })).map(
        (route) => route.path,
      ),
    ).toEqual(["/admin", "/admin/executions"]);
  });
});
