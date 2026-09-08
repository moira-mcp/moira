CREATE TABLE `executionMutationAttempt` (
	`attemptId` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`userId` text NOT NULL,
	`executionId` text,
	`reservedExecutionId` text,
	`executionRevision` integer,
	`nodeId` text,
	`workflowId` text NOT NULL,
	`workflowVersion` text NOT NULL,
	`workflowDigest` text NOT NULL,
	`requestPayload` text,
	`inputFingerprint` text,
	`state` text NOT NULL,
	`ownerId` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`heartbeatAt` integer,
	`leaseExpiresAt` integer,
	`response` text,
	`nextAttemptId` text,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`completedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executionId`) REFERENCES `workflowExecution`(`executionId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attempt_execution_state_idx` ON `executionMutationAttempt` (`executionId`,`state`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `attempt_user_operation_state_idx` ON `executionMutationAttempt` (`userId`,`operation`,`state`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `attempt_state_lease_idx` ON `executionMutationAttempt` (`state`,`leaseExpiresAt`);
--> statement-breakpoint
CREATE INDEX `attempt_operation_completed_idx` ON `executionMutationAttempt` (`operation`,`completedAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_reserved_execution_idx` ON `executionMutationAttempt` (`reservedExecutionId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_current_step_idx` ON `executionMutationAttempt` (`executionId`) WHERE `operation` = 'step' AND `state` IN ('presented', 'executing', 'outcome_unknown');
