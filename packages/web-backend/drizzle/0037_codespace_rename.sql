ALTER TABLE `workspaceConnection` RENAME TO `codespaceConnection`;
--> statement-breakpoint
ALTER TABLE `workspaceCredentialVault` RENAME TO `codespaceCredentialVault`;
--> statement-breakpoint
ALTER TABLE `workspaceCredentialRevocation` RENAME TO `codespaceCredentialRevocation`;
--> statement-breakpoint
ALTER TABLE `workspaceAuthorizationState` RENAME TO `codespaceAuthorizationState`;
--> statement-breakpoint
ALTER TABLE `workspaceConnectionInstallation` RENAME TO `codespaceConnectionInstallation`;
--> statement-breakpoint
ALTER TABLE `workspaceConnectionRepository` RENAME TO `codespaceConnectionRepository`;
--> statement-breakpoint
ALTER TABLE `workspaceResource` RENAME TO `codespaceResource`;
--> statement-breakpoint
ALTER TABLE `workspaceLifecycleCapability` RENAME TO `codespaceLifecycleCapability`;
--> statement-breakpoint
ALTER TABLE `workspacePolicyUsage` RENAME TO `codespacePolicyUsage`;
--> statement-breakpoint
ALTER TABLE `workspaceProviderMutation` RENAME TO `codespaceProviderMutation`;
--> statement-breakpoint
ALTER TABLE `workspaceProviderControl` RENAME TO `codespaceProviderControl`;
--> statement-breakpoint
ALTER TABLE `workspaceOperation` RENAME TO `codespaceOperation`;
--> statement-breakpoint
ALTER TABLE `workspaceTransfer` RENAME TO `codespaceTransfer`;
--> statement-breakpoint
ALTER TABLE `codespaceConnection` ADD `grantsRefreshedAt` integer;
--> statement-breakpoint
ALTER TABLE `codespaceConnection` ADD `grantsVersion` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `auditLog` ADD `dedupeKey` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_dedupe_key_idx` ON `auditLog` (`dedupeKey`);
--> statement-breakpoint
UPDATE `codespaceResource`
SET `lastOutcome` = replace(`lastOutcome`, 'workspace_', 'codespace_')
WHERE `lastOutcome` LIKE '%workspace_%';
--> statement-breakpoint
UPDATE `codespaceOperation`
SET `lastOutcome` = replace(`lastOutcome`, 'workspace_', 'codespace_')
WHERE `lastOutcome` LIKE '%workspace_%';
--> statement-breakpoint
UPDATE `codespaceTransfer`
SET `purpose` = replace(`purpose`, 'workspace_', 'codespace_')
WHERE `purpose` LIKE 'workspace_%';
--> statement-breakpoint
UPDATE `auditLog`
SET `action` = replace(`action`, 'workspace:', 'codespace:')
WHERE `action` LIKE 'workspace:%';
--> statement-breakpoint
UPDATE `auditLog`
SET `resource` = replace(`resource`, 'workspace_', 'codespace_')
WHERE `resource` LIKE 'workspace_%';
--> statement-breakpoint
UPDATE `auditLog`
SET `metadata` = replace(replace(`metadata`, '"workspaceId"', '"codespaceId"'), '"workspace_id"', '"codespace_id"')
WHERE `metadata` LIKE '%"workspaceId"%' OR `metadata` LIKE '%"workspace_id"%';
--> statement-breakpoint
DROP INDEX `workspace_connection_user_provider_idx`;
--> statement-breakpoint
DROP INDEX `workspace_connection_user_idx`;
--> statement-breakpoint
DROP INDEX `workspace_credential_revocation_user_provider_idx`;
--> statement-breakpoint
DROP INDEX `workspace_authorization_state_user_expires_idx`;
--> statement-breakpoint
DROP INDEX `workspace_connection_repository_connection_idx`;
--> statement-breakpoint
DROP INDEX `workspace_resource_operation_marker_idx`;
--> statement-breakpoint
DROP INDEX `workspace_resource_provider_name_idx`;
--> statement-breakpoint
DROP INDEX `workspace_resource_user_state_idx`;
--> statement-breakpoint
DROP INDEX `workspace_resource_reconcile_idx`;
--> statement-breakpoint
DROP INDEX `workspaceLifecycleCapability_capabilityHash_unique`;
--> statement-breakpoint
DROP INDEX `workspace_provider_mutation_attempt_idx`;
--> statement-breakpoint
DROP INDEX `workspace_provider_mutation_user_created_idx`;
--> statement-breakpoint
DROP INDEX `workspaceOperation_remoteMarker_unique`;
--> statement-breakpoint
DROP INDEX `workspace_operation_owner_idx`;
--> statement-breakpoint
DROP INDEX `workspace_operation_reconcile_idx`;
--> statement-breakpoint
DROP INDEX `workspaceTransfer_tokenDigest_unique`;
--> statement-breakpoint
DROP INDEX `workspaceTransfer_objectKey_unique`;
--> statement-breakpoint
DROP INDEX `workspace_transfer_owner_state_expiry_idx`;
--> statement-breakpoint
DROP INDEX `workspace_transfer_state_expiry_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_connection_user_provider_idx` ON `codespaceConnection` (`userId`,`provider`);
--> statement-breakpoint
CREATE INDEX `codespace_connection_user_idx` ON `codespaceConnection` (`userId`);
--> statement-breakpoint
CREATE INDEX `codespace_credential_revocation_user_provider_idx` ON `codespaceCredentialRevocation` (`userId`,`provider`);
--> statement-breakpoint
CREATE INDEX `codespace_authorization_state_user_expires_idx` ON `codespaceAuthorizationState` (`userId`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `codespace_connection_repository_connection_idx` ON `codespaceConnectionRepository` (`connectionId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_resource_operation_marker_idx` ON `codespaceResource` (`operationMarker`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_resource_provider_name_idx` ON `codespaceResource` (`provider`,`providerResourceName`);
--> statement-breakpoint
CREATE INDEX `codespace_resource_user_state_idx` ON `codespaceResource` (`userId`,`state`);
--> statement-breakpoint
CREATE INDEX `codespace_resource_reconcile_idx` ON `codespaceResource` (`state`,`claimExpiresAt`,`remoteExpiresAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespaceLifecycleCapability_capabilityHash_unique` ON `codespaceLifecycleCapability` (`capabilityHash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespace_provider_mutation_attempt_idx` ON `codespaceProviderMutation` (`resourceId`,`generation`,`kind`,`attempt`);
--> statement-breakpoint
CREATE INDEX `codespace_provider_mutation_user_created_idx` ON `codespaceProviderMutation` (`userId`,`createdAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespaceOperation_remoteMarker_unique` ON `codespaceOperation` (`remoteMarker`);
--> statement-breakpoint
CREATE INDEX `codespace_operation_owner_idx` ON `codespaceOperation` (`userId`,`resourceId`);
--> statement-breakpoint
CREATE INDEX `codespace_operation_reconcile_idx` ON `codespaceOperation` (`state`,`claimExpiresAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespaceTransfer_tokenDigest_unique` ON `codespaceTransfer` (`tokenDigest`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codespaceTransfer_objectKey_unique` ON `codespaceTransfer` (`objectKey`);
--> statement-breakpoint
CREATE INDEX `codespace_transfer_owner_state_expiry_idx` ON `codespaceTransfer` (`userId`,`state`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `codespace_transfer_state_expiry_idx` ON `codespaceTransfer` (`state`,`expiresAt`);
