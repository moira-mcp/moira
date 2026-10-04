CREATE TABLE `codespaceLocalPairing` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL,
  `codeDigest` text NOT NULL,
  `expiresAt` integer NOT NULL,
  `consumedAt` integer,
  `createdAt` integer NOT NULL,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_pairing_code_idx` ON `codespaceLocalPairing` (`codeDigest`);
--> statement-breakpoint
CREATE INDEX `codespace_local_pairing_owner_expiry_idx` ON `codespaceLocalPairing` (`userId`,`expiresAt`);
--> statement-breakpoint
CREATE TABLE `codespaceLocalDevice` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL,
  `label` text NOT NULL,
  `tokenDigest` text NOT NULL,
  `generation` integer DEFAULT 1 NOT NULL,
  `enabled` integer DEFAULT false NOT NULL,
  `leaseUntil` integer DEFAULT 0 NOT NULL,
  `snapshotVersion` integer DEFAULT 1 NOT NULL,
  `machineName` text NOT NULL,
  `machineDisplayName` text NOT NULL,
  `machineOperatingSystem` text NOT NULL,
  `machineCpuCores` integer NOT NULL,
  `machineMemoryBytes` integer NOT NULL,
  `machineStorageBytes` integer NOT NULL,
  `maxSandboxes` integer NOT NULL,
  `lastSeenAt` integer,
  `revokedAt` integer,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_device_token_idx` ON `codespaceLocalDevice` (`tokenDigest`);
--> statement-breakpoint
CREATE INDEX `codespace_local_device_owner_idx` ON `codespaceLocalDevice` (`userId`,`revokedAt`);
--> statement-breakpoint
CREATE TABLE `codespaceLocalRepository` (
  `deviceId` text NOT NULL,
  `externalRepositoryId` text NOT NULL,
  `publicRepositoryId` text NOT NULL,
  `fullName` text NOT NULL,
  `private` integer NOT NULL,
  `createdAt` integer NOT NULL,
  PRIMARY KEY(`deviceId`, `externalRepositoryId`),
  FOREIGN KEY (`deviceId`) REFERENCES `codespaceLocalDevice`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_repository_public_idx` ON `codespaceLocalRepository` (`publicRepositoryId`);
--> statement-breakpoint
CREATE TABLE `codespaceLocalResource` (
  `providerResourceName` text PRIMARY KEY NOT NULL,
  `deviceId` text NOT NULL,
  `spaceId` text NOT NULL,
  `operationMarker` text NOT NULL,
  `publicRepositoryId` text NOT NULL,
  `repositoryFullName` text NOT NULL,
  `ref` text NOT NULL,
  `generation` integer NOT NULL,
  `state` text NOT NULL,
  `phase` text NOT NULL,
  `lastStartedAt` integer,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`deviceId`) REFERENCES `codespaceLocalDevice`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_resource_space_idx` ON `codespaceLocalResource` (`deviceId`,`spaceId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_resource_marker_idx` ON `codespaceLocalResource` (`deviceId`,`operationMarker`);
--> statement-breakpoint
CREATE TABLE `codespaceLocalRelay` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL,
  `deviceId` text NOT NULL,
  `deviceGeneration` integer NOT NULL,
  `dedupeKey` text NOT NULL,
  `requestJson` text NOT NULL,
  `state` text NOT NULL,
  `leaseId` text,
  `leaseExpiresAt` integer,
  `replyJson` text,
  `expiresAt` integer NOT NULL,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`deviceId`) REFERENCES `codespaceLocalDevice`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_local_relay_dedupe_idx` ON `codespaceLocalRelay` (`deviceId`,`dedupeKey`);
--> statement-breakpoint
CREATE INDEX `codespace_local_relay_claim_idx` ON `codespaceLocalRelay` (`deviceId`,`state`,`leaseExpiresAt`,`expiresAt`);
