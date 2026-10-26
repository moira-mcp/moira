/** Stable JSON identity: object member order is irrelevant, array order remains significant. */
export function canonicalJson(value: unknown, keyOrder: "locale" | "ordinal" = "locale"): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, keyOrder)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) =>
        keyOrder === "ordinal"
          ? left < right
            ? -1
            : left > right
              ? 1
              : 0
          : left.localeCompare(right),
      )
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested, keyOrder)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
