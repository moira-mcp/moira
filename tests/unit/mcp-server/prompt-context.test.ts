/**
 * Unit tests for MCP Server prompt context extraction
 * Tests agent/model identification from request headers and OAuth app names
 */

import { describe, test, expect } from "@jest/globals";
import {
  extractAgentFromOAuthApp,
  validateModelHeader,
  AGENT_PATTERNS,
} from "../../../packages/mcp-server/src/utils/prompt-context.js";

describe("Prompt Context Extraction", () => {
  describe("extractAgentFromOAuthApp", () => {
    describe("Claude patterns", () => {
      test('returns "claude" for "Claude Code"', () => {
        expect(extractAgentFromOAuthApp("Claude Code")).toBe("claude");
      });

      test('returns "claude" for "Claude Desktop"', () => {
        expect(extractAgentFromOAuthApp("Claude Desktop")).toBe("claude");
      });

      test('returns "claude" for "Claude" alone', () => {
        expect(extractAgentFromOAuthApp("Claude")).toBe("claude");
      });

      test('returns "claude" case-insensitively', () => {
        expect(extractAgentFromOAuthApp("claude code")).toBe("claude");
        expect(extractAgentFromOAuthApp("CLAUDE CODE")).toBe("claude");
        expect(extractAgentFromOAuthApp("CLAUDE")).toBe("claude");
      });

      test('returns "claude" with extra whitespace', () => {
        expect(extractAgentFromOAuthApp("  Claude Code  ")).toBe("claude");
      });
    });

    describe("ChatGPT patterns", () => {
      test('returns "chatgpt" for "ChatGPT"', () => {
        expect(extractAgentFromOAuthApp("ChatGPT")).toBe("chatgpt");
      });

      test('returns "chatgpt" for "OpenAI" prefix', () => {
        expect(extractAgentFromOAuthApp("OpenAI")).toBe("chatgpt");
        expect(extractAgentFromOAuthApp("OpenAI Client")).toBe("chatgpt");
      });

      test('returns "chatgpt" case-insensitively', () => {
        expect(extractAgentFromOAuthApp("chatgpt")).toBe("chatgpt");
        expect(extractAgentFromOAuthApp("CHATGPT")).toBe("chatgpt");
        expect(extractAgentFromOAuthApp("openai")).toBe("chatgpt");
      });
    });

    describe("Gemini patterns", () => {
      test('returns "gemini" for "Gemini"', () => {
        expect(extractAgentFromOAuthApp("Gemini")).toBe("gemini");
      });

      test('returns "gemini" for "Google AI" prefix', () => {
        expect(extractAgentFromOAuthApp("Google AI")).toBe("gemini");
        expect(extractAgentFromOAuthApp("Google AI Studio")).toBe("gemini");
      });

      test('returns "gemini" case-insensitively', () => {
        expect(extractAgentFromOAuthApp("gemini")).toBe("gemini");
        expect(extractAgentFromOAuthApp("GEMINI")).toBe("gemini");
        expect(extractAgentFromOAuthApp("google ai")).toBe("gemini");
      });
    });

    describe("Cursor patterns", () => {
      test('returns "cursor" for "Cursor"', () => {
        expect(extractAgentFromOAuthApp("Cursor")).toBe("cursor");
      });

      test('returns "cursor" case-insensitively', () => {
        expect(extractAgentFromOAuthApp("cursor")).toBe("cursor");
        expect(extractAgentFromOAuthApp("CURSOR")).toBe("cursor");
      });
    });

    describe("Unknown and null cases", () => {
      test("returns null for unknown application names", () => {
        expect(extractAgentFromOAuthApp("Unknown App")).toBeNull();
        expect(extractAgentFromOAuthApp("My Custom Client")).toBeNull();
        expect(extractAgentFromOAuthApp("VSCode Extension")).toBeNull();
      });

      test("returns null for null input", () => {
        expect(extractAgentFromOAuthApp(null)).toBeNull();
      });

      test("returns null for undefined input", () => {
        expect(extractAgentFromOAuthApp(undefined)).toBeNull();
      });

      test("returns null for empty string", () => {
        expect(extractAgentFromOAuthApp("")).toBeNull();
        expect(extractAgentFromOAuthApp("   ")).toBeNull();
      });
    });
  });

  describe("validateModelHeader", () => {
    describe("Valid model identifiers", () => {
      test("accepts standard model names", () => {
        expect(validateModelHeader("gpt-4o")).toBe("gpt-4o");
        expect(validateModelHeader("claude-opus-4-5-20251101")).toBe("claude-opus-4-5-20251101");
        expect(validateModelHeader("gemini-1.5-pro")).toBe("gemini-1.5-pro");
      });

      test("lowercases the model identifier", () => {
        expect(validateModelHeader("GPT-4o")).toBe("gpt-4o");
        expect(validateModelHeader("Claude-Opus-4")).toBe("claude-opus-4");
      });

      test("trims whitespace", () => {
        expect(validateModelHeader("  gpt-4o  ")).toBe("gpt-4o");
        expect(validateModelHeader("\tgpt-4o\n")).toBe("gpt-4o");
      });

      test("accepts underscores and dots", () => {
        expect(validateModelHeader("model_v1.0")).toBe("model_v1.0");
        expect(validateModelHeader("my_model.test-2")).toBe("my_model.test-2");
      });
    });

    describe("Invalid model identifiers", () => {
      test("returns null for null input", () => {
        expect(validateModelHeader(null)).toBeNull();
      });

      test("returns null for undefined input", () => {
        expect(validateModelHeader(undefined)).toBeNull();
      });

      test("returns null for empty string", () => {
        expect(validateModelHeader("")).toBeNull();
        expect(validateModelHeader("   ")).toBeNull();
      });

      test("returns null for strings over 100 characters", () => {
        const longString = "a".repeat(101);
        expect(validateModelHeader(longString)).toBeNull();
      });

      test("accepts strings at exactly 100 characters", () => {
        const maxString = "a".repeat(100);
        expect(validateModelHeader(maxString)).toBe(maxString);
      });

      test("returns null for strings with invalid characters", () => {
        expect(validateModelHeader("model name")).toBeNull(); // space
        expect(validateModelHeader("model@name")).toBeNull(); // @
        expect(validateModelHeader("model!name")).toBeNull(); // !
        expect(validateModelHeader("model#name")).toBeNull(); // #
        expect(validateModelHeader("model/name")).toBeNull(); // /
        expect(validateModelHeader("model:name")).toBeNull(); // :
      });
    });
  });

  describe("AGENT_PATTERNS coverage", () => {
    test("has patterns for all expected agents", () => {
      const expectedAgents = ["claude", "chatgpt", "gemini", "cursor"];
      const patternAgents = AGENT_PATTERNS.map((p) => p.agent);

      for (const agent of expectedAgents) {
        expect(patternAgents).toContain(agent);
      }
    });

    test("each pattern is a valid RegExp", () => {
      for (const { pattern, agent } of AGENT_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(typeof agent).toBe("string");
        expect(agent.length).toBeGreaterThan(0);
      }
    });
  });
});
