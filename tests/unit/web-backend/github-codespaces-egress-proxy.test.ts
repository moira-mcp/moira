import { describe, expect, test } from "@jest/globals";
import {
  allowedHost,
  publicIp,
} from "../../../packages/web-backend/src/services/github-codespaces-egress-proxy.js";

describe("GitHub Codespaces credential-free egress policy", () => {
  test.each([
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "example.github.dev",
    "region.rel.tunnels.api.visualstudio.com",
  ])("allows reviewed provider host %s", (host) => expect(allowedHost(host)).toBe(true));

  test.each([
    "github.com.attacker.example",
    "attacker.example",
    "visualstudio.com",
    "localhost",
    "169.254.169.254",
  ])("rejects unreviewed or literal host %s", (host) => expect(allowedHost(host)).toBe(false));

  test.each([
    "127.0.0.1",
    "10.0.0.2",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.88.99.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("rejects non-public peer %s", (address) => expect(publicIp(address)).toBe(false));

  test.each(["140.82.112.3", "192.88.98.1", "198.51.99.1", "203.0.112.1", "2606:50c0:8000::154"])(
    "allows public peer %s",
    (address) => expect(publicIp(address)).toBe(true),
  );
});
