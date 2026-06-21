/**
 * Structured Condition System for safe condition evaluation
 * Replaces string-based eval() with structured, type-safe conditions
 */

// Condition operators
export type ConditionOperator =
  | "eq" // equals
  | "neq" // not equals
  | "gt" // greater than
  | "gte" // greater than or equal
  | "lt" // less than
  | "lte" // less than or equal
  | "contains" // string/array contains
  | "exists" // value exists (not null/undefined)
  | "and" // logical and
  | "or" // logical or
  | "not"; // logical not

// Value reference - either literal or context path
export type ConditionValue = string | number | boolean | null | { contextPath: string };

// Structured condition definition
export interface StructuredCondition {
  operator: ConditionOperator;

  // For binary operators (eq, gt, contains, etc.)
  left?: ConditionValue;
  right?: ConditionValue;

  // For logical operators (and, or)
  conditions?: StructuredCondition[];

  // For unary operators (not, exists)
  condition?: StructuredCondition;
  value?: ConditionValue; // For 'exists' operator
}

// Condition evaluation result
export interface ConditionResult {
  result: boolean;
  evaluatedValues: Record<string, unknown>; // For debugging
  error?: string;
}

// Helper functions for creating common conditions
export class ConditionBuilder {
  static equals(left: ConditionValue, right: ConditionValue): StructuredCondition {
    return { operator: "eq", left, right };
  }

  static greaterThan(left: ConditionValue, right: ConditionValue): StructuredCondition {
    return { operator: "gt", left, right };
  }

  static greaterThanOrEqual(left: ConditionValue, right: ConditionValue): StructuredCondition {
    return { operator: "gte", left, right };
  }

  static lessThan(left: ConditionValue, right: ConditionValue): StructuredCondition {
    return { operator: "lt", left, right };
  }

  static lessThanOrEqual(left: ConditionValue, right: ConditionValue): StructuredCondition {
    return { operator: "lte", left, right };
  }

  static exists(contextPath: string): StructuredCondition {
    return { operator: "exists", value: { contextPath } };
  }

  static and(...conditions: StructuredCondition[]): StructuredCondition {
    return { operator: "and", conditions };
  }

  static or(...conditions: StructuredCondition[]): StructuredCondition {
    return { operator: "or", conditions };
  }

  static not(condition: StructuredCondition): StructuredCondition {
    return { operator: "not", condition };
  }

  // Context path helper
  static contextPath(path: string): { contextPath: string } {
    return { contextPath: path };
  }
}
