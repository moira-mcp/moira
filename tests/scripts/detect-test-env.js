/**
 * Detect test environment from explicit --env flag.
 *
 * No auto-detection — mode must be passed explicitly via --env or npm script.
 * Defaults to "local" when --env is not provided.
 *
 * Usage:
 *   import { detectTestEnv } from './detect-test-env.js';
 *   const { testEnv, testFile, envExplicit } = detectTestEnv(process.argv.slice(2));
 */

/**
 * Parse CLI args for --env flag.
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{ testEnv: string, testFile: string|null, envExplicit: boolean }}
 */
export function detectTestEnv(args) {
  let testEnv = "local";
  let testFile = null;
  let envExplicit = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      testEnv = args[i + 1];
      envExplicit = true;
      i++;
    } else if (!args[i].startsWith("-")) {
      testFile = args[i];
    }
  }

  return { testEnv, testFile, envExplicit };
}
