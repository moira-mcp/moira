/** Decoded artifact content and its JSON transport frame are separate byte budgets. */
export const ARTIFACT_JSON_METADATA_BYTES = 64 * 1024;
const MIB = 1024 * 1024;

function validContentBytes(bytes: number): boolean {
  return (
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    Number.isSafeInteger(bytes * 6 + ARTIFACT_JSON_METADATA_BYTES)
  );
}

/** Worst-case JSON escaping uses six bytes for one decoded ASCII content byte. */
export function getArtifactJsonBodyLimit(maxContentBytes: number): number {
  if (!validContentBytes(maxContentBytes)) {
    throw new RangeError("Artifact size must permit a positive safe-integer JSON byte budget");
  }
  return maxContentBytes * 6 + ARTIFACT_JSON_METADATA_BYTES;
}

/** Null means invalid policy, including fractional bytes or an unrepresentable JSON frame. */
export function artifactFileSizeMbToBytes(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const mb = Number(value);
  const bytes = mb * MIB;
  return Number.isFinite(mb) && validContentBytes(bytes) ? bytes : null;
}
