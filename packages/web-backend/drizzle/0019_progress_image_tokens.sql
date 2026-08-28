ALTER TABLE `workflow_tokens` ADD `workflow_version` text;
--> statement-breakpoint
ALTER TABLE `workflow_tokens` ADD `execution_revision` integer;
--> statement-breakpoint
ALTER TABLE `workflow_tokens` ADD `options_json` text;
--> statement-breakpoint
ALTER TABLE `workflow_tokens` ADD `claim_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_tokens` ADD `claimed_at` integer;
