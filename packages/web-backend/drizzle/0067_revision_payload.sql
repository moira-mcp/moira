CREATE TABLE `revisionPayload` (
  `id` text PRIMARY KEY NOT NULL,
  `entityType` text NOT NULL,
  `entityId` text NOT NULL,
  `digest` text NOT NULL,
  `codec` text NOT NULL,
  `data` blob NOT NULL,
  `decodedSize` integer NOT NULL,
  `preview` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_payload_content_idx` ON `revisionPayload` (`entityType`,`entityId`,`digest`);
--> statement-breakpoint
ALTER TABLE `entityRevision` ADD `payloadId` text REFERENCES `revisionPayload` (`id`);
--> statement-breakpoint
CREATE INDEX `entity_revision_payload_idx` ON `entityRevision` (`payloadId`);
--> statement-breakpoint
CREATE TRIGGER `entity_revision_payload_insert` BEFORE INSERT ON `entityRevision`
WHEN NEW.payloadId IS NOT NULL AND (NEW.content IS NOT NULL OR NEW.entityType <> 'workflow')
BEGIN SELECT RAISE(ABORT, 'Invalid revision payload representation'); END;
--> statement-breakpoint
CREATE TRIGGER `entity_revision_payload_update` BEFORE UPDATE ON `entityRevision`
WHEN NEW.payloadId IS NOT NULL AND (NEW.content IS NOT NULL OR NEW.entityType <> 'workflow')
BEGIN SELECT RAISE(ABORT, 'Invalid revision payload representation'); END;
--> statement-breakpoint
CREATE TRIGGER `entity_revision_payload_delete` AFTER DELETE ON `entityRevision`
WHEN OLD.payloadId IS NOT NULL
BEGIN
  DELETE FROM revisionPayload WHERE id=OLD.payloadId
    AND NOT EXISTS (SELECT 1 FROM entityRevision WHERE payloadId=OLD.payloadId);
END;
--> statement-breakpoint
CREATE TRIGGER `entity_revision_payload_replaced` AFTER UPDATE OF payloadId ON `entityRevision`
WHEN OLD.payloadId IS NOT NULL AND OLD.payloadId IS NOT NEW.payloadId
BEGIN
  DELETE FROM revisionPayload WHERE id=OLD.payloadId
    AND NOT EXISTS (SELECT 1 FROM entityRevision WHERE payloadId=OLD.payloadId);
END;
