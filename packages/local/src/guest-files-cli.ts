import { runFilesClient } from "../../web-backend/src/services/github-codespaces-remote-supervisor.mjs";

await runFilesClient(process.argv.slice(2)).catch((error: unknown) => {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TRANSFER_OUTCOME_UNKNOWN"
      ? "TRANSFER_OUTCOME_UNKNOWN"
      : "CODESPACE_FILE_REJECTED";
  const diagnostic =
    code === "TRANSFER_OUTCOME_UNKNOWN" &&
    typeof error === "object" &&
    error !== null &&
    "diagnostic" in error &&
    typeof error.diagnostic === "object" &&
    error.diagnostic !== null &&
    "kind" in error.diagnostic &&
    typeof error.diagnostic.kind === "string" &&
    ["http", "transport", "process", "response_limit"].includes(error.diagnostic.kind)
      ? error.diagnostic
      : null;
  const safeDiagnostic = diagnostic
    ? {
        kind: diagnostic.kind,
        ...("httpStatus" in diagnostic &&
        typeof diagnostic.httpStatus === "number" &&
        Number.isInteger(diagnostic.httpStatus) &&
        diagnostic.httpStatus >= 400 &&
        diagnostic.httpStatus <= 599
          ? { httpStatus: diagnostic.httpStatus }
          : {}),
        ...("processExitCode" in diagnostic &&
        typeof diagnostic.processExitCode === "number" &&
        Number.isInteger(diagnostic.processExitCode) &&
        diagnostic.processExitCode > 0 &&
        diagnostic.processExitCode <= 255
          ? { processExitCode: diagnostic.processExitCode }
          : {}),
      }
    : null;
  process.stderr.write(
    `${JSON.stringify({ error: { code, ...(safeDiagnostic ? { diagnostic: safeDiagnostic } : {}) } })}\n`,
  );
  process.exitCode = 1;
});
