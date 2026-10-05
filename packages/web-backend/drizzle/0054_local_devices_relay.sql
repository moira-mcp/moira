CREATE TABLE codespaceLocalDevice (
 id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 connectionId TEXT NOT NULL REFERENCES codespaceConnection(id), label TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
 status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
 credentialDigest TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, policyDigest TEXT NOT NULL,
 lastSeenAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX codespace_local_device_owner_idx ON codespaceLocalDevice(userId,status);
--> statement-breakpoint
CREATE TABLE codespaceLocalPairing (
 id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 tokenDigest TEXT NOT NULL UNIQUE, deviceId TEXT REFERENCES codespaceLocalDevice(id),
 revision INTEGER NOT NULL DEFAULT 1, confirmedAt INTEGER, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX codespace_local_pairing_owner_expiry_idx ON codespaceLocalPairing(userId,expiresAt);
--> statement-breakpoint
CREATE TABLE codespaceLocalResourceBinding (
 resourceId TEXT PRIMARY KEY NOT NULL REFERENCES codespaceResource(id) ON DELETE CASCADE,
 userId TEXT NOT NULL REFERENCES user(id), deviceId TEXT NOT NULL REFERENCES codespaceLocalDevice(id),
 deviceGeneration INTEGER NOT NULL, repositoryId TEXT NOT NULL, profileId TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX codespace_local_binding_device_idx ON codespaceLocalResourceBinding(deviceId,deviceGeneration);
--> statement-breakpoint
CREATE TABLE codespaceLocalRelay (
 requestId TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id),
 deviceId TEXT NOT NULL REFERENCES codespaceLocalDevice(id), deviceGeneration INTEGER NOT NULL,
 connectionId TEXT NOT NULL REFERENCES codespaceConnection(id),
 resourceId TEXT NOT NULL REFERENCES codespaceResource(id), resourceGeneration INTEGER NOT NULL,
 digest TEXT NOT NULL, inputReference TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','completed','refused','expired','revoked')),
 claimId TEXT, claimExpiresAt INTEGER,
 outputReference TEXT,
 deadlineAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX codespace_local_relay_claim_idx ON codespaceLocalRelay(deviceId,deviceGeneration,status,deadlineAt,createdAt);
--> statement-breakpoint
CREATE INDEX codespace_local_relay_owner_deadline_idx ON codespaceLocalRelay(userId,deadlineAt,status);
--> statement-breakpoint
CREATE TABLE codespaceLocalRelayPart (
 transferId TEXT PRIMARY KEY NOT NULL REFERENCES codespaceTransfer(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL REFERENCES codespaceLocalRelay(requestId) ON DELETE CASCADE,
 claimId TEXT NOT NULL
);
