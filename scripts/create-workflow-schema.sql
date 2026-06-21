-- Workflow schema for MCP Moira
-- Add workflow and execution tables to existing Better Auth database
-- Note: Admin user seeded separately via scripts/run-migrations.ts

-- Workflow table
CREATE TABLE IF NOT EXISTS workflow (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  graph TEXT NOT NULL,
  visibility TEXT DEFAULT 'private',
  createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  updatedAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_userId ON workflow(userId);
CREATE INDEX IF NOT EXISTS idx_workflow_visibility ON workflow(visibility);
CREATE INDEX IF NOT EXISTS idx_workflow_updatedAt ON workflow(updatedAt DESC);

-- Workflow execution table
CREATE TABLE IF NOT EXISTS workflowExecution (
  executionId TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL,
  userId TEXT NOT NULL,
  state TEXT NOT NULL,
  currentNodeId TEXT,
  waitingForInputNodeId TEXT,
  context TEXT NOT NULL,
  error TEXT,
  createdAt INTEGER,
  updatedAt INTEGER,
  completedAt INTEGER,
  FOREIGN KEY (workflowId) REFERENCES workflow(id) ON DELETE CASCADE,
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_userId ON workflowExecution(userId);
CREATE INDEX IF NOT EXISTS idx_execution_workflowId ON workflowExecution(workflowId);
CREATE INDEX IF NOT EXISTS idx_execution_state ON workflowExecution(state);
CREATE INDEX IF NOT EXISTS idx_execution_createdAt ON workflowExecution(createdAt DESC);
