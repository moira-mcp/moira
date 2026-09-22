ALTER TABLE `codespaceResource` ADD `observedRef` text;
--> statement-breakpoint
ALTER TABLE `codespaceResource` ADD `reconcileFailures` integer NOT NULL DEFAULT 0;
