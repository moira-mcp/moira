import {
  validateReturnUrl,
  buildLoginUrlWithReturn,
} from "../../../packages/web-frontend/src/utils/return-url";

describe("validateReturnUrl", () => {
  it("accepts valid root-relative app paths", () => {
    expect(validateReturnUrl("/admin/audit-log")).toBe("/admin/audit-log");
    expect(validateReturnUrl("/workflows")).toBe("/workflows");
    expect(validateReturnUrl("/executions")).toBe("/executions");
    expect(validateReturnUrl("/settings")).toBe("/settings");
  });

  it("accepts paths with query parameters", () => {
    expect(validateReturnUrl("/workflows?filter=active")).toBe("/workflows?filter=active");
    expect(validateReturnUrl("/admin/users?page=2&sort=name")).toBe(
      "/admin/users?page=2&sort=name",
    );
  });

  it("rejects null and empty values", () => {
    expect(validateReturnUrl(null)).toBeNull();
    expect(validateReturnUrl("")).toBeNull();
  });

  it("rejects external URLs", () => {
    expect(validateReturnUrl("https://evil.com")).toBeNull();
    expect(validateReturnUrl("http://evil.com/admin")).toBeNull();
    expect(validateReturnUrl("ftp://server.com")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(validateReturnUrl("//evil.com")).toBeNull();
    expect(validateReturnUrl("//evil.com/admin")).toBeNull();
    expect(validateReturnUrl("/\\evil.com")).toBeNull();
  });

  it("rejects paths not starting with /", () => {
    expect(validateReturnUrl("admin")).toBeNull();
    expect(validateReturnUrl("workflows")).toBeNull();
  });

  it("rejects path traversal attempts", () => {
    expect(validateReturnUrl("/../etc/passwd")).toBeNull();
    expect(validateReturnUrl("/..")).toBeNull();
    expect(validateReturnUrl("/admin/../../secret")).toBeNull();
  });

  it("rejects embedded protocols", () => {
    expect(validateReturnUrl("/redirect?url=https://evil.com")).toBeNull();
  });

  it("rejects login/register pages to prevent loops", () => {
    expect(validateReturnUrl("/login")).toBeNull();
    expect(validateReturnUrl("/login?foo=bar")).toBeNull();
    expect(validateReturnUrl("/register")).toBeNull();
    expect(validateReturnUrl("/register?foo=bar")).toBeNull();
  });

  it("rejects javascript: and data: URLs", () => {
    expect(validateReturnUrl("javascript:alert(1)")).toBeNull();
    expect(validateReturnUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });
});

describe("buildLoginUrlWithReturn", () => {
  const LOGIN_ROUTE = "/login";

  it("returns plain login URL for app root", () => {
    expect(buildLoginUrlWithReturn("/", LOGIN_ROUTE)).toBe(LOGIN_ROUTE);
  });

  it("appends returnUrl for deep links", () => {
    expect(buildLoginUrlWithReturn("/admin/audit-log", LOGIN_ROUTE)).toBe(
      "/login?returnUrl=%2Fadmin%2Faudit-log",
    );
  });

  it("appends returnUrl with query parameters", () => {
    expect(buildLoginUrlWithReturn("/workflows?filter=active", LOGIN_ROUTE)).toBe(
      "/login?returnUrl=%2Fworkflows%3Ffilter%3Dactive",
    );
  });

  it("returns plain login URL for invalid paths", () => {
    expect(buildLoginUrlWithReturn("https://evil.com", LOGIN_ROUTE)).toBe(LOGIN_ROUTE);
    expect(buildLoginUrlWithReturn("//evil.com", LOGIN_ROUTE)).toBe(LOGIN_ROUTE);
  });
});
