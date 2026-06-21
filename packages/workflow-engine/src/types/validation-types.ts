/**
 * Validation and Error Handling Types for Graph Workflow Engine
 */

// Validation error for agent directive responses
export interface ValidationError {
  field: string;
  expected: string;
  received: string;
  message: string;
}
