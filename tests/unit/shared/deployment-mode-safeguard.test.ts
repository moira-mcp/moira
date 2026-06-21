import { describe, it, expect } from "@jest/globals";
import { evaluateUnsetModeSafeguard } from "@mcp-moira/shared";

/**
 * The unset-DEPLOYMENT_MODE safeguard must convert a silent self-host downgrade
 * on a hosted deployment into a loud failure (production) or warning (dev),
 * while never interfering with a properly-configured or local install.
 */
describe("evaluateUnsetModeSafeguard", () => {
  it("refuses to boot (error) in production on a public host with unset mode", () => {
    expect(
      evaluateUnsetModeSafeguard({
        host: "example.com",
        deploymentModeSet: false,
        isProduction: true,
      }),
    ).toBe("error");
  });

  it("warns (not error) in non-production on a public host with unset mode", () => {
    expect(
      evaluateUnsetModeSafeguard({
        host: "moira.example.com",
        deploymentModeSet: false,
        isProduction: false,
      }),
    ).toBe("warn");
  });

  it("is OK when the mode is explicitly set, even in production on a public host", () => {
    expect(
      evaluateUnsetModeSafeguard({
        host: "example.com",
        deploymentModeSet: true,
        isProduction: true,
      }),
    ).toBe("ok");
  });

  it("is OK on a localhost host regardless of mode/prod (local dev never blocked)", () => {
    expect(
      evaluateUnsetModeSafeguard({
        host: "localhost:3031",
        deploymentModeSet: false,
        isProduction: true,
      }),
    ).toBe("ok");
  });

  it("is OK on a 127.x host (loopback treated as local)", () => {
    expect(
      evaluateUnsetModeSafeguard({
        host: "127.0.0.1:8080",
        deploymentModeSet: false,
        isProduction: true,
      }),
    ).toBe("ok");
  });

  it("is OK when host is empty (no host to judge)", () => {
    expect(
      evaluateUnsetModeSafeguard({ host: "", deploymentModeSet: false, isProduction: true }),
    ).toBe("ok");
  });
});
