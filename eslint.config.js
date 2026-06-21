import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import astroPlugin from "eslint-plugin-astro";
import astroParser from "astro-eslint-parser";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.node,
      },
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "unused-imports": unusedImportsPlugin,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "unused-imports/no-unused-imports": "error",
      "no-console": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            "Direct process.env access is forbidden. Use config module from @mcp-moira/shared",
        },
      ],
    },
  },
  // Tests - relaxed rules
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx", "tests/**/*.js", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  // E2E tests - require fixtures import
  {
    files: ["tests/e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              message:
                "Use './fixtures.js' instead of '@playwright/test' in E2E tests to enable automatic console/network logging.",
            },
          ],
        },
      ],
    },
  },
  // Scripts - allow console, add globals for JS
  {
    files: ["scripts/**/*.ts", "scripts/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  // Workflow CLI - allow console (CLI tool)
  {
    files: ["packages/workflow-cli/**/*.ts", "packages/workflow-cli/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  // Config files - allow process.env
  {
    files: [
      "packages/shared/src/config/**/*.ts",
      "packages/shared/src/logging/logger.ts",
      "drizzle.config.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // MCP Server - ban z.array(z.any()) as it produces invalid JSON Schema (breaks ChatGPT integration)
  {
    files: ["packages/mcp-server/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='z'][callee.property.name='array'] > CallExpression[callee.object.name='z'][callee.property.name='any']",
          message:
            "z.array(z.any()) produces invalid JSON Schema that breaks ChatGPT/OpenAI integration. Use z.array(z.unknown()) or z.array(z.record(z.unknown())) instead.",
        },
      ],
    },
  },
  // Frontend - allow process.env (Vite handles it)
  {
    files: ["packages/web-frontend/**/*.ts", "packages/web-frontend/**/*.tsx"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Docs TypeScript (Astro site)
  {
    files: ["packages/docs/**/*.ts", "packages/docs/**/*.tsx"],
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  // Astro files
  ...astroPlugin.configs.recommended,
  {
    files: ["packages/docs/**/*.astro"],
    languageOptions: {
      parser: astroParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: [".astro"],
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
      // Disable React rules for Astro
      "react/no-unknown-property": "off",
      "react/jsx-key": "off",
      "react/jsx-no-undef": "off",
      "react/jsx-no-comment-textnodes": "off",
      "react/no-unescaped-entities": "off",
    },
  },
  // Ignores
  {
    ignores: [
      "node_modules",
      "**/dist",
      "build",
      "**/.astro",
      "coverage",
      "test-results",
      "playwright-report",
      ".husky",
      "**/*.d.ts",
      "**/*.config.js",
      "**/*.config.cjs",
      "drizzle/**/*.ts",
      "claude-temp-files",
      "moira-ws",
    ],
  },
  // k6 load testing files - uses its own runtime with different globals
  {
    files: ["load-tests/k6/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        console: "readonly",
        open: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-redeclare": "off",
    },
  },
];
