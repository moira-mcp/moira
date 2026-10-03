CREATE INDEX IF NOT EXISTS `session_user_expiry_activity_idx` ON `session` (`userId`,`expiresAt`,`updatedAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_activity_expiry_idx` ON `session` (`updatedAt`,`expiresAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `execution_user_created_idx` ON `workflowExecution` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `execution_workflow_created_idx` ON `workflowExecution` (`workflowId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `execution_state_created_idx` ON `workflowExecution` (`state`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `execution_created_idx` ON `workflowExecution` (`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_user_created_idx` ON `auditLog` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_resource_action_created_idx` ON `auditLog` (`resourceId`,`action`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_created_idx` ON `auditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_registration_epoch_idx` ON `user` (CASE WHEN `createdAt` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' THEN cast(unixepoch(`createdAt`, 'subsec')*1000 AS integer) END);
