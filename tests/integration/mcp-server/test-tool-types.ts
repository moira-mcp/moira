/**
 * Type definitions for MCP tool test responses
 */

export interface CreateWorkflowResponse {
  success: boolean;
  workflowId: string;
  message: string;
  metadata: {
    name: string;
    version: string;
    description: string;
    nodeCount: number;
  };
  validation: {
    valid: boolean;
    warnings?: string[];
  };
}

export interface EditWorkflowResponse {
  success: boolean;
  changes: {
    metadataUpdated?: boolean;
    nodesAdded?: number;
    nodesUpdated?: number;
    nodesRemoved?: number;
  };
  metadata: {
    name: string;
    version: string;
    description: string;
    nodeCount: number;
  };
  validation: {
    valid: boolean;
    errors?: string[];
    warnings?: string[];
  };
}

export interface GetWorkflowDetailsResponse {
  success: boolean;
  workflowId: string;
  metadata: {
    name: string;
    version: string;
    description: string;
  };
  structure: {
    nodeCount: number;
    hasStartNode: boolean;
    hasEndNode: boolean;
    agentDirectiveCount: number;
    conditionCount: number;
  };
  nodes?: any[];
  validation: {
    valid: boolean;
    errors?: string[];
    warnings?: string[];
  };
}
