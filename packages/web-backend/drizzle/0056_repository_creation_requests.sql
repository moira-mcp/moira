CREATE TABLE `codespaceRepositoryRequest` (
  `requestId` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `deviceId` text NOT NULL REFERENCES `codespaceLocalDevice`(`id`),
  `deviceGeneration` integer NOT NULL,
  `localConnectionId` text NOT NULL,
  `githubConnectionId` text NOT NULL,
  `githubUserId` text NOT NULL,
  `owner` text NOT NULL,
  `credentialGeneration` integer NOT NULL,
  `repositoryName` text NOT NULL,
  `installationId` text NOT NULL,
  `fingerprint` text NOT NULL,
  `delegation` text NOT NULL,
  `marker` text NOT NULL,
  `admissionRequestId` text NOT NULL UNIQUE,
  `state` text NOT NULL,
  `repositoryId` text,
  `fullName` text,
  `installationVerified` integer DEFAULT 0 NOT NULL,
  `reservationHeld` integer DEFAULT 1 NOT NULL,
  `claimId` text,
  `claimExpiresAt` integer,
  `errorCode` text,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `codespace_repository_request_device_capacity_idx` ON `codespaceRepositoryRequest` (`deviceId`, `reservationHeld`);
--> statement-breakpoint
CREATE INDEX `codespace_repository_request_owner_name_idx` ON `codespaceRepositoryRequest` (`userId`, `githubUserId`, `repositoryName`);
