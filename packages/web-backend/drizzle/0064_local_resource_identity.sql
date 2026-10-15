CREATE TABLE archiveLocalResourceLegacyCurrent AS SELECT * FROM codespaceResource;
--> statement-breakpoint
CREATE TABLE archiveLocalResourceBindingLegacyCurrent AS SELECT * FROM codespaceLocalResourceBinding;
--> statement-breakpoint
CREATE TABLE localResourceIdentity (
 id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id),
 connectionId TEXT NOT NULL REFERENCES codespaceConnection(id), authorizationGeneration INTEGER NOT NULL,
 repositoryId TEXT NOT NULL, repositoryFullName TEXT NOT NULL, requestedRef TEXT NOT NULL,
 operationMarker TEXT NOT NULL, routeGeneration INTEGER NOT NULL CHECK(routeGeneration>0),
 createdAt INTEGER NOT NULL, retiredAt INTEGER, retiredGeneration INTEGER, retiredRequestId TEXT,
 CONSTRAINT local_resource_retirement CHECK((retiredAt IS NULL AND retiredGeneration IS NULL AND retiredRequestId IS NULL)
 OR (retiredAt IS NOT NULL AND retiredGeneration IS NOT NULL AND retiredGeneration>0))
);
--> statement-breakpoint
INSERT INTO localResourceIdentity
 SELECT id,userId,connectionId,authorizationGeneration,repositoryId,repositoryFullName,requestedRef,operationMarker,generation,createdAt,
 CASE WHEN state='deleted' THEN updatedAt ELSE NULL END,
 CASE WHEN state='deleted' THEN generation ELSE NULL END,NULL
 FROM codespaceResource;
--> statement-breakpoint
CREATE TABLE codespaceLocalResourceBindingNext (
 resourceId TEXT PRIMARY KEY NOT NULL REFERENCES localResourceIdentity(id) ON DELETE CASCADE,
 userId TEXT NOT NULL REFERENCES user(id), deviceId TEXT NOT NULL REFERENCES codespaceLocalDevice(id),
 deviceGeneration INTEGER NOT NULL, repositoryId TEXT NOT NULL, profileId TEXT NOT NULL, revokedAt INTEGER
);
--> statement-breakpoint
INSERT INTO codespaceLocalResourceBindingNext SELECT * FROM codespaceLocalResourceBinding;
--> statement-breakpoint
DROP TABLE codespaceLocalResourceBinding;
--> statement-breakpoint
ALTER TABLE codespaceLocalResourceBindingNext RENAME TO codespaceLocalResourceBinding;
--> statement-breakpoint
CREATE INDEX codespace_local_binding_device_idx ON codespaceLocalResourceBinding(deviceId,deviceGeneration);
--> statement-breakpoint
DROP TABLE codespaceResource;
--> statement-breakpoint
CREATE INDEX local_resource_owner_idx ON localResourceIdentity(userId);
--> statement-breakpoint
CREATE UNIQUE INDEX local_resource_operation_marker_idx ON localResourceIdentity(operationMarker);
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_current_insert BEFORE INSERT ON archiveLocalResourceLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_current_update BEFORE UPDATE ON archiveLocalResourceLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_current_delete BEFORE DELETE ON archiveLocalResourceLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_binding_current_insert BEFORE INSERT ON archiveLocalResourceBindingLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_binding_current_update BEFORE UPDATE ON archiveLocalResourceBindingLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_binding_current_delete BEFORE DELETE ON archiveLocalResourceBindingLegacyCurrent BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
