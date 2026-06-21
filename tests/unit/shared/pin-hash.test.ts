/**
 * Unit tests for execution-lock PIN hashing (scrypt, salted, constant-time verify).
 */

import { describe, it, expect } from "@jest/globals";
import { hashPin, verifyPin, isHashedPin } from "@mcp-moira/shared";

describe("PIN hashing", () => {
  it("produces the scrypt$salt$hash format and never stores plaintext", () => {
    const hashed = hashPin("123456");
    expect(hashed.startsWith("scrypt$")).toBe(true);
    expect(hashed.split("$")).toHaveLength(3);
    expect(hashed).not.toContain("123456");
    expect(isHashedPin(hashed)).toBe(true);
  });

  it("salts each hash (same PIN → different stored values)", () => {
    expect(hashPin("123456")).not.toBe(hashPin("123456"));
  });

  it("verifies the correct PIN", () => {
    const hashed = hashPin("654321");
    expect(verifyPin("654321", hashed)).toBe(true);
  });

  it("rejects an incorrect PIN", () => {
    const hashed = hashPin("654321");
    expect(verifyPin("000000", hashed)).toBe(false);
  });

  it("rejects a legacy plaintext value (no migration of in-flight locks)", () => {
    // A pre-hash row stored the raw PIN; it must NOT verify as itself.
    expect(verifyPin("123456", "123456")).toBe(false);
  });

  it("rejects malformed / empty stored values without throwing", () => {
    expect(verifyPin("123456", "")).toBe(false);
    expect(verifyPin("123456", "scrypt$only-two")).toBe(false);
    expect(verifyPin("123456", "bcrypt$aa$bb")).toBe(false);
    expect(verifyPin("123456", "scrypt$zz$zz")).toBe(false); // non-hex
  });

  it("isHashedPin distinguishes hashed from plaintext", () => {
    expect(isHashedPin(hashPin("111111"))).toBe(true);
    expect(isHashedPin("111111")).toBe(false);
    expect(isHashedPin("")).toBe(false);
  });
});
