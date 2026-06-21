/** @type {import('jest').Config} */
export default {
  rootDir: "../../",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: {
            syntax: "typescript",
            tsx: true,
            decorators: true,
          },
          target: "es2022",
        },
        module: {
          type: "es6",
        },
      },
    ],
  },
  transformIgnorePatterns: ["node_modules/(?!(@noble/ciphers|better-auth)/)"],
  moduleNameMapper: {
    "^@mcp-moira/([^/]+)/(.+)\\.js$": "<rootDir>/packages/$1/src/$2",
    "^@mcp-moira/([^/]+)$": "<rootDir>/packages/$1/src",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: [
    "packages/*/src/**/*.ts",
    "!packages/*/src/**/*.d.ts",
    "!packages/*/src/**/index.ts",
  ],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
};
