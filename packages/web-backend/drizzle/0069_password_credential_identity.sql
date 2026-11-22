-- Better Auth looks up password accounts by their existing owner ID.
-- Refuse ambiguous historical bindings before changing any credential.
CREATE TEMP TABLE password_credential_owner_check (
  valid INTEGER CONSTRAINT unambiguous_password_credential_owner CHECK (valid = 1)
);
--> statement-breakpoint
INSERT INTO password_credential_owner_check (valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM account AS legacy
  JOIN account AS other ON other.providerId = 'credential' AND other.id <> legacy.id
    AND (other.userId = legacy.userId OR other.accountId = legacy.userId)
  WHERE legacy.providerId = 'credential' AND legacy.accountId <> legacy.userId
);
--> statement-breakpoint
UPDATE account SET accountId = userId
WHERE providerId = 'credential' AND accountId <> userId;
--> statement-breakpoint
DROP TABLE password_credential_owner_check;
