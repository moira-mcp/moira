import { readFile } from "node:fs/promises";

/** Reject apparent passes that the framework's process or report cannot support. */
export async function guardSuccessfulFrameworkRun(suite, result) {
  // Testfold already classified these failures. Keep their original diagnostics and category.
  if (!result.success) return { ok: true };

  const errors = [];
  try {
    const log = await readFile(result.logFile, "utf8");
    // The executor owns these first three lines. Framework stdout cannot supply an exit code.
    const header = /^Command: [^\r\n]*\r?\nExit Code: (-?\d+)\r?\nDuration: \d+ms(?:\r?\n|$)/.exec(
      log,
    );
    if (!header) errors.push("Framework executor log has no valid exit-code header");
    else if (Number(header[1]) !== 0)
      errors.push(`Framework process exited with code ${header[1]}`);
  } catch {
    errors.push(`Framework executor log is unavailable: ${result.logFile}`);
  }

  if (!Number.isInteger(result.passed) || result.passed <= 0)
    errors.push("Framework reported no executed passing tests (skipped tests are not execution)");

  if (suite.type === "playwright") {
    try {
      const report = JSON.parse(await readFile(result.resultFile, "utf8"));
      if (!Array.isArray(report.errors)) {
        errors.push("Playwright report has no valid global-errors array");
      } else {
        for (const error of report.errors)
          errors.push(`Playwright global error: ${error.message ?? JSON.stringify(error)}`);
      }
    } catch {
      errors.push(`Playwright report is unavailable or invalid: ${result.resultFile}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join("\n") };
}
