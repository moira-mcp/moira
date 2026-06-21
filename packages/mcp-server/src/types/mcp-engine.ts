/**
 * Strict TypeScript interfaces for MCPEngine methods
 * Comprehensive type safety and error handling definitions
 */

// Step execution parameters with strict typing
export interface ExecuteStepParams {
  processId: string;
  input: Record<string, unknown>;
  workflowsDirectory?: string;
}

// Workflow start parameters with validation
export interface StartWorkflowParams {
  workflowId: string;
  workflowsDirectory?: string;
}

// Process state query parameters
export interface ProcessStateParams {
  processId: string;
  workflowsDirectory?: string;
}

// Workflow creation parameters with overwrite control
export interface CreateWorkflowParams {
  workflow: WorkflowDefinition;
  overwrite?: boolean;
  workflowsDirectory?: string;
}

// Workflow editing parameters with change tracking
export interface EditWorkflowParams {
  workflowId: string;
  changes: WorkflowChanges;
  workflowsDirectory?: string;
}

// Workflow details query parameters
export interface WorkflowDetailsParams {
  workflowId: string;
  includeNodes?: boolean;
  includeValidation?: boolean;
  workflowsDirectory?: string;
}

// Workflow definition structure
export interface WorkflowDefinition {
  id: string;
  metadata: WorkflowMetadata;
  nodes: WorkflowNode[];
}

export interface WorkflowMetadata {
  name: string;
  version: string;
  description: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  connections?: Record<string, string>;
  [key: string]: unknown;
}

// Workflow change operations
export interface WorkflowChanges {
  metadata?: Partial<WorkflowMetadata>;
  addNodes?: WorkflowNode[];
  removeNodes?: string[];
  updateNodes?: NodeUpdate[];
}

export interface NodeUpdate {
  nodeId: string;
  changes: Record<string, unknown>;
}

// Result interfaces with strict typing
export interface ProcessResult {
  success: true;
  processId: string;
  currentStep: StepGuidance;
}

export interface StepResult {
  success: true;
  processId: string;
  nextStep?: StepGuidance;
  completed?: boolean;
}

export interface StateResult {
  success: true;
  process: ProcessState;
}

export interface WorkflowListResult {
  success: true;
  workflows: WorkflowSummary[];
}

export interface CreateWorkflowResult {
  success: true;
  workflowId: string;
  message: string;
  metadata: WorkflowMetadata;
  validation: ValidationResult;
}

export interface EditWorkflowResult {
  success: true;
  workflowId: string;
  changes: ChangesSummary;
  metadata: WorkflowMetadata;
  validation: ValidationResult;
}

export interface WorkflowDetailsResult {
  success: true;
  workflowId: string;
  metadata: WorkflowMetadata;
  structure: WorkflowStructure;
  nodes?: WorkflowNode[];
  validation?: ValidationResult;
}

// Supporting interfaces
export interface StepGuidance {
  processId: string;
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
}

export interface ProcessState {
  id: string;
  workflow: { name: string };
  currentStepId: string;
  state: ProcessStatus;
  context: { variables: Record<string, unknown> };
  startedAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  isValid: boolean;
  validationErrors?: string[];
}

export interface WorkflowStructure {
  nodeCount: number;
  nodeTypes: Record<string, number>;
  hasStartNode: boolean;
  hasEndNode: boolean;
  agentDirectiveCount: number;
  conditionCount: number;
  telegramCount: number;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  code?: string;
}

export interface ChangesSummary {
  metadataUpdated?: boolean;
  nodesAdded?: number;
  nodesRemoved?: number;
  nodesUpdated?: number;
}

// Process status enum for type safety
// Issue #386: 2-status model - "running" (active) and "completed" (finished)
// Legacy "waiting" merged into "running", "failed" merged into "completed"
export type ProcessStatus = "running" | "completed";

// Error result interface
export interface ErrorResult {
  success: false;
  error: string;
  code?: string;
}
