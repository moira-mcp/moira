ALTER TABLE `workflow_tokens` ADD `execution_id` text REFERENCES workflowExecution(executionId) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `workflow_tokens` ADD `node_id` text;
