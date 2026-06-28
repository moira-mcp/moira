/**
 * Domain Error Classes
 *
 * Custom error classes for domain-specific exceptions
 * These map to HTTP status codes and MCP error codes at the boundary
 */

/**
 * Base class for domain errors
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to a plain object for serialization
   */
  toJSON(): { code: string; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// ===== Not Found Errors =====

/**
 * Workflow not found error
 */
export class WorkflowNotFoundError extends DomainError {
  readonly code = "WORKFLOW_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly identifier: string,
    public readonly identifierType: "id" | "slug" | "reference" = "id",
  ) {
    super(`Workflow not found: ${identifier}`);
  }
}

/**
 * User not found error
 */
export class UserNotFoundError extends DomainError {
  readonly code = "USER_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly identifier: string,
    public readonly identifierType: "id" | "handle" = "id",
  ) {
    super(`User not found: ${identifier}`);
  }
}

// ===== Conflict Errors =====

/**
 * Slug already exists for this user
 */
export class SlugConflictError extends DomainError {
  readonly code = "SLUG_CONFLICT";
  readonly httpStatus = 409;

  constructor(
    public readonly slug: string,
    public readonly userId: string,
  ) {
    super(`Slug '${slug}' already exists for this user`);
  }
}

/**
 * Handle already taken by another user
 */
export class HandleConflictError extends DomainError {
  readonly code = "HANDLE_CONFLICT";
  readonly httpStatus = 409;

  constructor(public readonly handle: string) {
    super(`Handle '${handle}' is already taken`);
  }
}

// ===== Validation Errors =====

/**
 * Invalid slug format
 */
export class InvalidSlugError extends DomainError {
  readonly code = "INVALID_SLUG";
  readonly httpStatus = 400;

  constructor(
    public readonly slug: string,
    public readonly reason: string,
  ) {
    super(`Invalid slug '${slug}': ${reason}`);
  }
}

/**
 * Invalid handle format
 */
export class InvalidHandleError extends DomainError {
  readonly code = "INVALID_HANDLE";
  readonly httpStatus = 400;

  constructor(
    public readonly handle: string,
    public readonly reason: string,
  ) {
    super(`Invalid handle '${handle}': ${reason}`);
  }
}

// ===== Note Errors =====

/**
 * Note not found error
 */
export class NoteNotFoundError extends DomainError {
  readonly code = "NOTE_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(public readonly key: string) {
    super(`Note not found: ${key}`);
  }
}

/**
 * Note version not found
 */
export class NoteVersionNotFoundError extends DomainError {
  readonly code = "NOTE_VERSION_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly key: string,
    public readonly version: number,
  ) {
    super(`Note version ${version} not found for key: ${key}`);
  }
}

/**
 * Invalid note key format
 */
export class InvalidNoteKeyError extends DomainError {
  readonly code = "INVALID_NOTE_KEY";
  readonly httpStatus = 400;

  constructor(
    public readonly key: string,
    public readonly reason: string,
  ) {
    super(`Invalid note key '${key}': ${reason}`);
  }
}

/**
 * Invalid tag format
 */
export class InvalidTagError extends DomainError {
  readonly code = "INVALID_TAG";
  readonly httpStatus = 400;

  constructor(
    public readonly tag: string,
    public readonly reason: string,
  ) {
    super(`Invalid tag '${tag}': ${reason}`);
  }
}

/**
 * Too many tags on a note
 */
export class TooManyTagsError extends DomainError {
  readonly code = "TOO_MANY_TAGS";
  readonly httpStatus = 400;

  constructor(
    public readonly count: number,
    public readonly limit: number = 10,
  ) {
    super(`Too many tags: ${count} (maximum: ${limit})`);
  }
}

/**
 * Note size exceeds limit
 */
export class NoteSizeExceededError extends DomainError {
  readonly code = "NOTE_SIZE_EXCEEDED";
  readonly httpStatus = 400;

  constructor(
    public readonly size: number,
    public readonly limit: number = 102400,
  ) {
    super(`Note size ${formatBytes(size)} exceeds limit of ${formatBytes(limit)}`);
  }
}

/**
 * User quota exceeded
 */
export class QuotaExceededError extends DomainError {
  readonly code = "QUOTA_EXCEEDED";
  readonly httpStatus = 400;

  constructor(
    public readonly currentSize: number,
    public readonly noteSize: number,
    public readonly limit: number = 1048576,
  ) {
    super(
      `Quota exceeded: adding ${formatBytes(noteSize)} to ${formatBytes(currentSize)} would exceed limit of ${formatBytes(limit)}`,
    );
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ===== Access Errors =====

/**
 * Access denied to workflow
 */
export class WorkflowAccessDeniedError extends DomainError {
  readonly code = "WORKFLOW_ACCESS_DENIED";
  readonly httpStatus = 403;

  constructor(
    public readonly workflowId: string,
    public readonly userId: string,
    public readonly action: "read" | "write" | "delete" = "read",
  ) {
    super(`Access denied: you cannot ${action} workflow '${workflowId}'`);
  }
}

// ===== Sharing Errors =====

/**
 * Invite not found error
 */
export class InviteNotFoundError extends DomainError {
  readonly code = "INVITE_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly identifier: string,
    public readonly identifierType: "id" | "token" = "id",
  ) {
    super(`Invite not found: ${identifier}`);
  }
}

/**
 * Invite expired error
 */
export class InviteExpiredError extends DomainError {
  readonly code = "INVITE_EXPIRED";
  readonly httpStatus = 410;

  constructor(public readonly token: string) {
    super("Invite link has expired");
  }
}

/**
 * Invite already used error
 */
export class InviteAlreadyUsedError extends DomainError {
  readonly code = "INVITE_ALREADY_USED";
  readonly httpStatus = 410;

  constructor(public readonly token: string) {
    super("Invite link has already been used");
  }
}

/**
 * Self-invite error (owner trying to accept own invite)
 */
export class SelfInviteError extends DomainError {
  readonly code = "SELF_INVITE";
  readonly httpStatus = 400;

  constructor() {
    super("You cannot accept an invite to your own workflow");
  }
}

/**
 * Access already granted error
 */
export class AccessAlreadyExistsError extends DomainError {
  readonly code = "ACCESS_ALREADY_EXISTS";
  readonly httpStatus = 409;

  constructor(
    public readonly workflowId: string,
    public readonly userId: string,
  ) {
    super("User already has access to this workflow");
  }
}

/**
 * Access not found error
 */
export class AccessNotFoundError extends DomainError {
  readonly code = "ACCESS_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly workflowId: string,
    public readonly userId: string,
  ) {
    super("User does not have access to this workflow");
  }
}

// ===== Artifact Errors =====

/**
 * Artifact not found error
 */
export class ArtifactNotFoundError extends DomainError {
  readonly code = "ARTIFACT_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(public readonly uuid: string) {
    super(`Artifact not found: ${uuid}`);
  }
}

/**
 * Artifact size exceeds limit
 */
export class ArtifactSizeExceededError extends DomainError {
  readonly code = "ARTIFACT_SIZE_EXCEEDED";
  readonly httpStatus = 400;

  constructor(
    public readonly size: number,
    public readonly limit: number,
  ) {
    super(`Artifact size ${formatBytes(size)} exceeds limit of ${formatBytes(limit)}`);
  }
}

/**
 * Artifact quota exceeded (total storage or file count)
 */
export class ArtifactQuotaExceededError extends DomainError {
  readonly code = "ARTIFACT_QUOTA_EXCEEDED";
  readonly httpStatus = 400;

  constructor(
    public readonly quotaType: "storage" | "count",
    public readonly current: number,
    public readonly limit: number,
  ) {
    const message =
      quotaType === "storage"
        ? `Storage quota exceeded: ${formatBytes(current)} used of ${formatBytes(limit)} limit`
        : `File count quota exceeded: ${current} files of ${limit} limit`;
    super(message);
  }
}

/**
 * Access denied to artifact (not owner)
 */
export class ArtifactAccessDeniedError extends DomainError {
  readonly code = "ARTIFACT_ACCESS_DENIED";
  readonly httpStatus = 403;

  constructor(
    public readonly uuid: string,
    public readonly action: "update" | "delete" = "update",
  ) {
    super(`Access denied: you cannot ${action} artifact '${uuid}'`);
  }
}

/**
 * Invalid artifact content (not valid HTML)
 */
export class InvalidArtifactContentError extends DomainError {
  readonly code = "INVALID_ARTIFACT_CONTENT";
  readonly httpStatus = 400;

  constructor(public readonly reason: string) {
    super(`Invalid artifact content: ${reason}`);
  }
}

/**
 * Invalid artifact token
 */
export class InvalidArtifactTokenError extends DomainError {
  readonly code = "INVALID_ARTIFACT_TOKEN";
  readonly httpStatus = 401;

  constructor(public readonly reason: string = "Token is invalid, expired, or already used") {
    super(reason);
  }
}

// ===== Marketplace Errors =====

/**
 * Marketplace is not enabled in this deployment.
 */
export class MarketplaceDisabledError extends DomainError {
  readonly code = "MARKETPLACE_DISABLED";
  readonly httpStatus = 404;

  constructor() {
    super("The marketplace is not enabled on this instance");
  }
}

/**
 * Marketplace listing not found.
 */
export class ListingNotFoundError extends DomainError {
  readonly code = "LISTING_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(
    public readonly identifier: string,
    public readonly identifierType: "id" | "workflowId" = "id",
  ) {
    super(`Marketplace listing not found: ${identifier}`);
  }
}

/**
 * The workflow already has a marketplace listing.
 */
export class WorkflowAlreadyListedError extends DomainError {
  readonly code = "WORKFLOW_ALREADY_LISTED";
  readonly httpStatus = 409;

  constructor(public readonly workflowId: string) {
    super(`Workflow '${workflowId}' is already published to the marketplace`);
  }
}

/**
 * A flow cannot be made private while it has an active (listed) marketplace
 * listing — doing so silently would orphan the listing. The caller must
 * unpublish first (which makes the flow private and unlists it atomically).
 */
export class WorkflowListedCannotGoPrivateError extends DomainError {
  readonly code = "WORKFLOW_LISTED_CANNOT_GO_PRIVATE";
  readonly httpStatus = 409;

  constructor(public readonly workflowId: string) {
    super(
      `Workflow '${workflowId}' has an active marketplace listing and cannot be made private directly. Unpublish it first.`,
    );
  }
}

/**
 * A listing cannot be set `listed` because its workflow is not public (private or
 * deleted) — doing so would orphan the listing (the publication invariant: a listed
 * listing always references a public, non-deleted workflow). Make the workflow public
 * (publish) first.
 */
export class WorkflowNotListableError extends DomainError {
  readonly code = "WORKFLOW_NOT_LISTABLE";
  readonly httpStatus = 409;

  constructor(public readonly workflowId: string) {
    super(
      `Workflow '${workflowId}' cannot be listed because it is private or deleted. Make it public first.`,
    );
  }
}

/**
 * Caller is not allowed to manage this listing (not the publisher/owner).
 */
export class ListingAccessDeniedError extends DomainError {
  readonly code = "LISTING_ACCESS_DENIED";
  readonly httpStatus = 403;

  constructor(
    public readonly identifier: string,
    public readonly action: "publish" | "unpublish" | "manage" = "manage",
  ) {
    super(`Access denied: you cannot ${action} listing for '${identifier}'`);
  }
}

/**
 * The listing cannot be added/accessed (e.g. a paid listing while selling is off).
 */
export class ListingNotAccessibleError extends DomainError {
  readonly code = "LISTING_NOT_ACCESSIBLE";
  readonly httpStatus = 403;

  constructor(
    public readonly listingId: string,
    public readonly reason: string,
  ) {
    super(`Listing '${listingId}' is not accessible: ${reason}`);
  }
}

/**
 * Library entry not found for this user/workflow.
 */
export class LibraryEntryNotFoundError extends DomainError {
  readonly code = "LIBRARY_ENTRY_NOT_FOUND";
  readonly httpStatus = 404;

  constructor(public readonly workflowId: string) {
    super(`Library entry not found for workflow '${workflowId}'`);
  }
}

/**
 * An author cannot rate/review their own listing.
 */
export class SelfRatingError extends DomainError {
  readonly code = "SELF_RATING_FORBIDDEN";
  readonly httpStatus = 403;

  constructor() {
    super("You cannot rate your own listing");
  }
}

/**
 * An author cannot install/adopt their own listing into their library — they already
 * own the workflow, and a self-install would inflate the install/trending counters.
 */
export class SelfInstallError extends DomainError {
  readonly code = "SELF_INSTALL_FORBIDDEN";
  readonly httpStatus = 403;

  constructor() {
    super("You cannot install your own listing");
  }
}

/**
 * Star rating is outside the allowed 1-5 range.
 */
export class InvalidRatingError extends DomainError {
  readonly code = "INVALID_RATING";
  readonly httpStatus = 400;

  constructor(public readonly stars: number) {
    super(`Invalid rating ${stars}: stars must be an integer from 1 to 5`);
  }
}

/**
 * A paid listing was requested (publish with paid fields, or purchase) while the
 * `paidWorkflows` feature is disabled.
 */
export class PaidListingsDisabledError extends DomainError {
  readonly code = "PAID_LISTINGS_DISABLED";
  readonly httpStatus = 400;

  constructor() {
    super("Paid listings are not available on this instance yet");
  }
}

/**
 * A listing status transition targeted a value outside the allowed set.
 */
export class InvalidListingStatusError extends DomainError {
  readonly code = "INVALID_LISTING_STATUS";
  readonly httpStatus = 400;

  constructor(
    public readonly status: string,
    allowed: readonly string[],
  ) {
    super(`Invalid listing status '${status}': expected one of ${allowed.join(", ")}`);
  }
}

// ===== Type Guards =====

/**
 * Check if error is a DomainError
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Check if error is a not-found error
 */
export function isNotFoundError(
  error: unknown,
): error is
  | WorkflowNotFoundError
  | UserNotFoundError
  | NoteNotFoundError
  | NoteVersionNotFoundError
  | InviteNotFoundError
  | AccessNotFoundError
  | ArtifactNotFoundError {
  return (
    error instanceof WorkflowNotFoundError ||
    error instanceof UserNotFoundError ||
    error instanceof NoteNotFoundError ||
    error instanceof NoteVersionNotFoundError ||
    error instanceof InviteNotFoundError ||
    error instanceof AccessNotFoundError ||
    error instanceof ArtifactNotFoundError
  );
}

/**
 * Check if error is a conflict error
 */
export function isConflictError(
  error: unknown,
): error is SlugConflictError | HandleConflictError | AccessAlreadyExistsError {
  return (
    error instanceof SlugConflictError ||
    error instanceof HandleConflictError ||
    error instanceof AccessAlreadyExistsError
  );
}

/**
 * Check if error is a validation error
 */
export function isValidationError(
  error: unknown,
): error is
  | InvalidSlugError
  | InvalidHandleError
  | InvalidNoteKeyError
  | InvalidTagError
  | TooManyTagsError
  | NoteSizeExceededError
  | QuotaExceededError {
  return (
    error instanceof InvalidSlugError ||
    error instanceof InvalidHandleError ||
    error instanceof InvalidNoteKeyError ||
    error instanceof InvalidTagError ||
    error instanceof TooManyTagsError ||
    error instanceof NoteSizeExceededError ||
    error instanceof QuotaExceededError
  );
}
