/** Global settings persist strings; the shared editor consumes typed field values. */
export function globalSettingEditorValue(type: string, value: string | null): unknown {
  if (value === null) return null;
  if (type === "boolean") return value === "true" || value === "1";
  if (type === "number") return value === "" ? "" : Number(value);
  return value;
}

export function globalSettingStoredValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
