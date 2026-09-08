CREATE TABLE `workspaceResource` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`connectionId` text NOT NULL,
	`provider` text NOT NULL,
	`repositoryId` text NOT NULL,
	`repositoryFullName` text NOT NULL,
	`requestedRef` text NOT NULL,
	`operationMarker` text NOT NULL,
	`providerResourceName` text,
	`externalOwnerId` text,
	`billableOwnerId` text,
	`machineName` text NOT NULL,
	`machineDisplayName` text NOT NULL,
	`machineOperatingSystem` text NOT NULL,
	`machineCpuCores` integer NOT NULL,
	`machineMemoryBytes` integer NOT NULL,
	`machineStorageBytes` integer NOT NULL,
	`state` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`createDeadlineAt` integer NOT NULL,
	`remoteExpiresAt` integer NOT NULL,
	`cleanupDeadlineAt` integer,
	`claimId` text,
	`claimExpiresAt` integer,
	`lastOutcome` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connectionId`) REFERENCES `workspaceConnection`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_resource_operation_marker_idx` ON `workspaceResource` (`operationMarker`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_resource_provider_name_idx` ON `workspaceResource` (`provider`,`providerResourceName`);
--> statement-breakpoint
CREATE INDEX `workspace_resource_user_state_idx` ON `workspaceResource` (`userId`,`state`);
--> statement-breakpoint
CREATE INDEX `workspace_resource_reconcile_idx` ON `workspaceResource` (`state`,`claimExpiresAt`,`remoteExpiresAt`);
--> statement-breakpoint
CREATE TABLE `workspaceLifecycleCapability` (
	`resourceId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`capabilityHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`resourceId`) REFERENCES `workspaceResource`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceLifecycleCapability_capabilityHash_unique` ON `workspaceLifecycleCapability` (`capabilityHash`);
--> statement-breakpoint
CREATE TABLE `workspacePolicyUsage` (
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`utcDay` text NOT NULL,
	`submittedOperations` integer DEFAULT 0 NOT NULL,
	`requiredCleanupOperations` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `provider`, `utcDay`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaceProviderMutation` (
	`id` text PRIMARY KEY NOT NULL,
	`resourceId` text NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`generation` integer NOT NULL,
	`kind` text NOT NULL,
	`attempt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`resourceId`) REFERENCES `workspaceResource`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_provider_mutation_attempt_idx` ON `workspaceProviderMutation` (`resourceId`,`generation`,`kind`,`attempt`);
--> statement-breakpoint
CREATE INDEX `workspace_provider_mutation_user_created_idx` ON `workspaceProviderMutation` (`userId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `workspaceProviderControl` (
	`scope` text PRIMARY KEY NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`reason` text,
	`updatedAt` integer NOT NULL,
	`updatedBy` text,
	FOREIGN KEY (`updatedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
