/**
 * Unit tests for TRUST_PROXY parsing: which proxies may report the client address.
 */

import { describe, it, expect } from "@jest/globals";
import { DEFAULT_TRUST_PROXY, parseTrustProxy } from "@mcp-moira/shared";

describe("parseTrustProxy", () => {
  it.each([undefined, "", "   "])("trusts only loopback when the value is %p", (raw) => {
    expect(parseTrustProxy(raw)).toEqual(DEFAULT_TRUST_PROXY);
    expect(DEFAULT_TRUST_PROXY).toEqual(["loopback"]);
  });

  it.each([
    ["2", 2],
    ["0", 0],
    ["loopback", ["loopback"]],
    ["loopback, 172.18.0.0/16", ["loopback", "172.18.0.0/16"]],
    ["10.1.2.3,fd00::/8,uniquelocal", ["10.1.2.3", "fd00::/8", "uniquelocal"]],
  ])("accepts %p", (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it.each([
    "true",
    "false",
    "*",
    "loopback, everyone",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.1/8/1",
    "-1",
    ",",
  ])("refuses %p", (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow(/Invalid TRUST_PROXY/);
  });
});
