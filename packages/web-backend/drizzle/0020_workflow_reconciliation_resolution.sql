CREATE TABLE `workflowReconciliationResolution` (
	`ownerId` text NOT NULL,
	`slug` text NOT NULL,
	`incomingDigest` text NOT NULL,
	`resultDigest` text NOT NULL,
	`selection` text NOT NULL,
	`merged` integer NOT NULL,
	`rationale` text NOT NULL,
	`residualDelta` text NOT NULL,
	`actorId` text,
	`source` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`ownerId`, `slug`)
);
