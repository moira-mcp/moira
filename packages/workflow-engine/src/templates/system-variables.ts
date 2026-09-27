/**
 * The engine's own template values: available in every template without a registry declaration,
 * resolved by the template processor, and never treated as author data by the validator.
 */
export const SYSTEM_TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  "executionId",
  "workflowId",
  "userId",
  "runUrl",
]);
