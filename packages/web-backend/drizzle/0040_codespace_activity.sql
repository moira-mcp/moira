ALTER TABLE `codespaceResource` ADD `lastActivityAt` integer;
--> statement-breakpoint
ALTER TABLE `codespaceResource` ADD `providerLastUsedAt` integer;
--> statement-breakpoint
ALTER TABLE `codespaceConnection` ADD `resourcesObservedAt` integer;
