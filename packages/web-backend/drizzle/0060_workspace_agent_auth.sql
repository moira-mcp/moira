CREATE TABLE `workspaceAgentCredential` (
  `resourceId` text PRIMARY KEY NOT NULL REFERENCES `codespaceResource`(`id`) ON DELETE CASCADE,
  `userId` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `credentialDigest` text NOT NULL UNIQUE,
  `resourceGeneration` integer NOT NULL,
  `authorizationGeneration` integer NOT NULL,
  `environmentIdentity` text NOT NULL,
  `expiresAt` integer,
  `createdAt` integer NOT NULL
);
