ALTER TABLE `workspaceResource` ADD `authorizationGeneration` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaceResource` ADD `retentionPolicy` text DEFAULT 'legacy_disposable' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaceResource` ADD `desiredState` text DEFAULT 'running' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspaceResource` ADD `observedState` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
UPDATE `workspaceResource`
SET `authorizationGeneration` = COALESCE(
  (SELECT `credentialGeneration` FROM `workspaceConnection`
   WHERE `workspaceConnection`.`id` = `workspaceResource`.`connectionId`),
  1
),
`desiredState` = CASE
  WHEN `state` IN ('deleted', 'rejected', 'cleanup_pending') THEN 'deleted'
  ELSE 'running'
END,
`observedState` = CASE
  WHEN `state` = 'usable' THEN 'running'
  WHEN `state` = 'deleted' THEN 'absent'
  WHEN `state` = 'cleanup_pending' THEN 'deleting'
  WHEN `state` IN ('create_pending', 'create_submitted') THEN 'provisioning'
  WHEN `state` = 'rejected' THEN 'failed'
  ELSE 'unknown'
END;
--> statement-breakpoint
CREATE TABLE `workspaceOperation` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL,
  `resourceId` text NOT NULL,
  `resourceGeneration` integer NOT NULL,
  `authorizationGeneration` integer NOT NULL,
  `provider` text NOT NULL,
  `providerResourceName` text NOT NULL,
  `remoteMarker` text NOT NULL,
  `kind` text NOT NULL,
  `state` text NOT NULL,
  `inputBytes` integer NOT NULL,
  `stdoutLimitBytes` integer NOT NULL,
  `stderrLimitBytes` integer NOT NULL,
  `outputBytes` integer DEFAULT 0 NOT NULL,
  `exitCode` integer,
  `remoteCleanupPending` integer DEFAULT 1 NOT NULL,
  `resultExpiresAt` integer,
  `deadlineAt` integer NOT NULL,
  `claimId` text,
  `claimExpiresAt` integer,
  `lastOutcome` text,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`resourceId`) REFERENCES `workspaceResource`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceOperation_remoteMarker_unique` ON `workspaceOperation` (`remoteMarker`);
--> statement-breakpoint
CREATE INDEX `workspace_operation_owner_idx` ON `workspaceOperation` (`userId`,`resourceId`);
--> statement-breakpoint
CREATE INDEX `workspace_operation_reconcile_idx` ON `workspaceOperation` (`state`,`claimExpiresAt`);
