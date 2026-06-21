/**
 * Unit tests for detect-test-env.js — explicit --env flag parsing
 */

import { describe, it, expect } from "@jest/globals";
import { detectTestEnv } from "../../scripts/detect-test-env.js";

describe("detect-test-env", () => {
  describe("detectTestEnv", () => {
    it("defaults to 'local' when no --env flag", () => {
      const result = detectTestEnv([]);
      expect(result.testEnv).toBe("local");
      expect(result.testFile).toBeNull();
      expect(result.envExplicit).toBe(false);
    });

    it("returns 'remote' with --env remote", () => {
      const result = detectTestEnv(["--env", "remote"]);
      expect(result.testEnv).toBe("remote");
      expect(result.envExplicit).toBe(true);
    });

    it("returns 'local' with --env local", () => {
      const result = detectTestEnv(["--env", "local"]);
      expect(result.testEnv).toBe("local");
      expect(result.envExplicit).toBe(true);
    });

    it("returns 'staging' with --env staging", () => {
      const result = detectTestEnv(["--env", "staging"]);
      expect(result.testEnv).toBe("staging");
      expect(result.envExplicit).toBe(true);
    });

    it("parses test file path without --env", () => {
      const result = detectTestEnv(["tests/api/auth.test.ts"]);
      expect(result.testEnv).toBe("local");
      expect(result.testFile).toBe("tests/api/auth.test.ts");
      expect(result.envExplicit).toBe(false);
    });

    it("parses both --env and test file path", () => {
      const result = detectTestEnv(["--env", "remote", "tests/api/auth.test.ts"]);
      expect(result.testEnv).toBe("remote");
      expect(result.testFile).toBe("tests/api/auth.test.ts");
      expect(result.envExplicit).toBe(true);
    });

    it("parses test file before --env flag", () => {
      const result = detectTestEnv(["tests/api/auth.test.ts", "--env", "remote"]);
      expect(result.testEnv).toBe("remote");
      expect(result.testFile).toBe("tests/api/auth.test.ts");
      expect(result.envExplicit).toBe(true);
    });

    it("ignores --env without value", () => {
      const result = detectTestEnv(["--env"]);
      expect(result.testEnv).toBe("local");
      expect(result.envExplicit).toBe(false);
    });
  });
});
