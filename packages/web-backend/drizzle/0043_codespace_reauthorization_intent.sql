ALTER TABLE `codespaceAuthorizationState` ADD `intent` text NOT NULL DEFAULT 'connect';
--> statement-breakpoint
ALTER TABLE `codespaceAuthorizationState` ADD `expectedConnectionId` text;
--> statement-breakpoint
ALTER TABLE `codespaceAuthorizationState` ADD `expectedGeneration` integer;
