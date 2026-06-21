-- Add validation cache columns to workflow table (Issue #463)
-- These columns cache validation results to avoid re-validating on every list request
ALTER TABLE `workflow` ADD `isValid` integer;--> statement-breakpoint
ALTER TABLE `workflow` ADD `validationErrors` text;--> statement-breakpoint
ALTER TABLE `workflow` ADD `validatedAt` integer;
