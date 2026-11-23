CREATE TABLE publicationLink (
  id TEXT PRIMARY KEY NOT NULL,
  campaign TEXT NOT NULL,
  source TEXT NOT NULL,
  publication TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en','ru'))
);
--> statement-breakpoint
CREATE TABLE publicationVisit (
  id INTEGER PRIMARY KEY,
  publicationId TEXT NOT NULL REFERENCES publicationLink(id),
  acceptedAt INTEGER NOT NULL,
  tokenDigest TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX publication_visit_token_idx ON publicationVisit(tokenDigest) WHERE tokenDigest IS NOT NULL;
--> statement-breakpoint
CREATE INDEX publication_visit_expiry_idx ON publicationVisit(acceptedAt) WHERE tokenDigest IS NOT NULL;
--> statement-breakpoint
CREATE INDEX publication_visit_period_idx ON publicationVisit(publicationId, acceptedAt);
--> statement-breakpoint
CREATE TABLE publicationRegistration (
  userId TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  publicationId TEXT NOT NULL REFERENCES publicationLink(id)
);
