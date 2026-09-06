/**
 * A bundle whose manifest is fine and whose code fails the moment it is imported. Manifest checks
 * happen before any extension code runs, so this failure can only be observed in the handler
 * process.
 */

throw new Error("this bundle explodes on import");
