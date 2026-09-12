CREATE TABLE `workspaceConnection` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`externalAccountId` text NOT NULL,
	`externalLogin` text NOT NULL,
	`status` text NOT NULL,
	`credentialGeneration` integer DEFAULT 1 NOT NULL,
	`refreshLeaseId` text,
	`refreshLeaseExpiresAt` integer,
	`lastErrorCode` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_connection_user_provider_idx` ON `workspaceConnection` (`userId`,`provider`);
--> statement-breakpoint
CREATE INDEX `workspace_connection_user_idx` ON `workspaceConnection` (`userId`);
--> statement-breakpoint
CREATE TABLE `workspaceCredentialVault` (
	`connectionId` text PRIMARY KEY NOT NULL,
	`envelopeVersion` integer NOT NULL,
	`keyVersion` text NOT NULL,
	`iv` text NOT NULL,
	`authTag` text NOT NULL,
	`ciphertext` text NOT NULL,
	`generation` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `workspaceConnection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaceCredentialRevocation` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`envelopeVersion` integer NOT NULL,
	`keyVersion` text NOT NULL,
	`iv` text NOT NULL,
	`authTag` text NOT NULL,
	`ciphertext` text NOT NULL,
	`generation` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_credential_revocation_user_provider_idx` ON `workspaceCredentialRevocation` (`userId`,`provider`);
--> statement-breakpoint
CREATE TABLE `workspaceAuthorizationState` (
	`stateHash` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sessionTokenHash` text NOT NULL,
	`provider` text NOT NULL,
	`redirectPath` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`consumedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_authorization_state_user_expires_idx` ON `workspaceAuthorizationState` (`userId`,`expiresAt`);
--> statement-breakpoint
CREATE TABLE `workspaceConnectionInstallation` (
	`connectionId` text NOT NULL,
	`externalInstallationId` text NOT NULL,
	`repositorySelection` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`connectionId`, `externalInstallationId`),
	FOREIGN KEY (`connectionId`) REFERENCES `workspaceConnection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaceConnectionRepository` (
	`connectionId` text NOT NULL,
	`externalInstallationId` text NOT NULL,
	`externalRepositoryId` text NOT NULL,
	`fullName` text NOT NULL,
	`private` integer NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`connectionId`, `externalRepositoryId`),
	FOREIGN KEY (`connectionId`) REFERENCES `workspaceConnection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_connection_repository_connection_idx` ON `workspaceConnectionRepository` (`connectionId`);
