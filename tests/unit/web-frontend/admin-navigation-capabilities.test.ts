import {
  filterNavRoutes,
  type NavRoute,
} from "../../../packages/web-frontend/src/components/layout/AppSidebar";

const routes: NavRoute[] = [
  { path: "/admin", label: "Dashboard", icon: "home" },
  { path: "/admin/users", label: "Users", icon: "users", userManagement: true },
  {
    path: "/admin/executions",
    label: "Executions",
    icon: "runs",
    multiUserAdmin: true,
  },
];

describe("admin navigation capabilities", () => {
  test("self-host exposes Users without exposing broader multi-user operations", () => {
    expect(
      filterNavRoutes(routes, true, { userManagement: true, multiUserAdmin: false }).map(
        (route) => route.path,
      ),
    ).toEqual(["/admin", "/admin/users"]);
  });

  test("SaaS retains both user and broader multi-user navigation", () => {
    expect(
      filterNavRoutes(routes, true, { userManagement: true, multiUserAdmin: true }).map(
        (route) => route.path,
      ),
    ).toEqual(["/admin", "/admin/users", "/admin/executions"]);
  });

  test("a disabled Users capability removes the route independently", () => {
    expect(
      filterNavRoutes(routes, true, { userManagement: false, multiUserAdmin: true }).map(
        (route) => route.path,
      ),
    ).toEqual(["/admin", "/admin/executions"]);
  });
});
