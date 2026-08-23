CREATE TABLE `managedWorkflowBaseline` (
	`ownerId` text NOT NULL,
	`slug` text NOT NULL,
	`state` text NOT NULL,
	`sourceVersion` text,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`ownerId`, `slug`)
);
--> statement-breakpoint
CREATE TABLE `workflowReconciliationConflict` (
	`ownerId` text NOT NULL,
	`slug` text NOT NULL,
	`currentWorkflowId` text,
	`currentWorkflowSlug` text,
	`previousManagedSlug` text,
	`classification` text NOT NULL,
	`previousState` text,
	`currentState` text NOT NULL,
	`incomingState` text NOT NULL,
	`instruction` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`ownerId`, `slug`)
);
