import { runFilesClient } from "../../web-backend/src/services/github-codespaces-remote-supervisor.mjs";

await runFilesClient(process.argv.slice(2)).catch((error: unknown) => {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TRANSFER_OUTCOME_UNKNOWN"
      ? "TRANSFER_OUTCOME_UNKNOWN"
      : "CODESPACE_FILE_REJECTED";
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  process.exitCode = 1;
});
