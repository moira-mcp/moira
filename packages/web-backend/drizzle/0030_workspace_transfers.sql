CREATE TABLE `workspaceTransfer` (
  `id` text PRIMARY KEY NOT NULL,
  `tokenDigest` text NOT NULL,
  `userId` text NOT NULL,
  `purpose` text NOT NULL,
  `state` text NOT NULL,
  `fileName` text NOT NULL,
  `mimeType` text NOT NULL,
  `declaredSize` integer NOT NULL,
  `observedSize` integer,
  `sha256` text,
  `objectKey` text NOT NULL,
  `ownerPid` integer NOT NULL,
  `ownerStartTime` text,
  `claimId` text,
  `claimExpiresAt` integer,
  `expiresAt` integer NOT NULL,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceTransfer_tokenDigest_unique` ON `workspaceTransfer` (`tokenDigest`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceTransfer_objectKey_unique` ON `workspaceTransfer` (`objectKey`);
--> statement-breakpoint
CREATE INDEX `workspace_transfer_owner_state_expiry_idx` ON `workspaceTransfer` (`userId`,`state`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `workspace_transfer_state_expiry_idx` ON `workspaceTransfer` (`state`,`expiresAt`);
