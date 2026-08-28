const EXECUTION_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isExecutionParentReference(value: string): boolean {
  return value === "none" || EXECUTION_UUID_V4.test(value);
}
