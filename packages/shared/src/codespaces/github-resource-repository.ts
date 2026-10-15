import type Database from "better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { CodespaceResourceError } from "./resource-types.js";
import type { CodespaceProviderResource } from "./resource-types.js";

/** Identity, revocation and billable ownership only. Lifecycle receipts belong to the controller. */
export interface GitHubResourceIdentity {
  id: string;
  userId: string;
  connectionId: string;
  authorizationGeneration: number;
  repositoryId: string;
  repositoryFullName: string;
  requestedRef: string;
  devcontainerPath: string | null;
  operationMarker: string;
  providerResourceName: string | null;
  externalOwnerId: string;
  billableOwnerId: string;
  deviceId: string | null;
  deviceGeneration: number | null;
  deviceConnectionId: string | null;
  generation: number;
  retirement: "uncreated" | "unknown" | "owned" | "retired";
  revokedAt: number | null;
  createdAt: number;
}

export class GitHubResourceRepository {
  constructor(readonly db: Database.Database) {}

  getOwned(userId: string, id: string): GitHubResourceIdentity | null {
    return (
      (this.db
        .prepare("SELECT * FROM githubResourceIdentity WHERE userId=? AND id=?")
        .get(userId, id) as GitHubResourceIdentity | undefined) ?? null
    );
  }

  listOwned(userId: string): GitHubResourceIdentity[] {
    return this.db
      .prepare("SELECT * FROM githubResourceIdentity WHERE userId=? ORDER BY createdAt DESC")
      .all(userId) as GitHubResourceIdentity[];
  }
  assign(
    userId: string,
    id: string,
    device: { deviceId: string; deviceGeneration: number; connectionId: string },
  ): GitHubResourceIdentity {
    const current = this.getOwned(userId, id);
    if (!current || current.revokedAt !== null || current.retirement === "retired")
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Resource assignment refused",
      );
    if (
      current.deviceId &&
      (current.deviceId !== device.deviceId ||
        current.deviceGeneration !== device.deviceGeneration ||
        current.deviceConnectionId !== device.connectionId)
    )
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Resource already has another controller assignment",
      );
    this.db
      .prepare(
        `UPDATE githubResourceIdentity SET deviceId=?,deviceGeneration=?,deviceConnectionId=? WHERE userId=? AND id=? AND revokedAt IS NULL`,
      )
      .run(device.deviceId, device.deviceGeneration, device.connectionId, userId, id);
    return this.getOwned(userId, id)!;
  }
  rebind(
    userId: string,
    id: string,
    input: {
      connectionId: string;
      authorizationGeneration: number;
      deviceId: string;
      deviceGeneration: number;
      deviceConnectionId: string;
      expectedGeneration: number;
      resourceGeneration: number;
      repositoryFullName: string;
      providerResourceName: string;
      retirement: GitHubResourceIdentity["retirement"];
    },
  ) {
    const current = this.getOwned(userId, id);
    if (
      !current ||
      (current.providerResourceName !== null &&
        current.providerResourceName !== input.providerResourceName) ||
      (current.retirement === "retired" &&
        (input.retirement !== "retired" || input.resourceGeneration !== current.generation))
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Resource reauthorization refused",
      );
    const result = this.db
      .prepare(
        `UPDATE githubResourceIdentity SET connectionId=@connectionId,authorizationGeneration=@authorizationGeneration,
      deviceId=@deviceId,deviceGeneration=@deviceGeneration,deviceConnectionId=@deviceConnectionId,
      repositoryFullName=@repositoryFullName,providerResourceName=@providerResourceName,generation=@resourceGeneration,retirement=@retirement,revokedAt=NULL
      WHERE userId=@userId AND id=@id AND generation=@expectedGeneration`,
      )
      .run({ userId, id, ...input });
    if (result.changes !== 1)
      throw new CodespaceResourceError(
        "CODESPACE_GENERATION_CONFLICT",
        "Observed assignment generation changed",
      );
    return this.getOwned(userId, id)!;
  }
  observeCreation(
    userId: string,
    id: string,
    expectedGeneration: number,
    observed: CodespaceProviderResource | "refused",
  ) {
    return this.db
      .transaction(() => {
        const current = this.getOwned(userId, id);
        if (!current)
          throw new CodespaceResourceError(
            "CODESPACE_NOT_FOUND",
            "Original creation identity is missing",
          );
        if (
          current.generation !== expectedGeneration ||
          current.revokedAt !== null ||
          current.retirement !== "unknown"
        )
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Original creation authority changed before its reply was registered",
          );
        if (observed === "refused") {
          if (current.providerResourceName === null)
            this.db
              .prepare(
                "UPDATE githubResourceIdentity SET retirement='retired' WHERE userId=? AND id=?",
              )
              .run(userId, id);
        } else {
          if (
            (current.providerResourceName && current.providerResourceName !== observed.name) ||
            observed.displayName !== current.operationMarker ||
            observed.repositoryId !== current.repositoryId ||
            observed.ownerId !== current.externalOwnerId ||
            observed.billableOwnerId !== current.billableOwnerId
          )
            throw new CodespaceResourceError(
              "CODESPACE_GENERATION_CONFLICT",
              "Provider creation identity changed",
            );
          this.db
            .prepare(
              "UPDATE githubResourceIdentity SET providerResourceName=?,retirement='owned' WHERE userId=? AND id=?",
            )
            .run(observed.name, userId, id);
        }
        return this.getOwned(userId, id)!;
      })
      .immediate();
  }

  /** Fence a potentially billable POST before dispatch, without storing its lifecycle receipt. */
  markCreationSubmitted(userId: string, id: string, generation: number): void {
    const result = this.db
      .prepare(
        `UPDATE githubResourceIdentity SET retirement='unknown'
      WHERE userId=? AND id=? AND generation=? AND revokedAt IS NULL
      AND retirement='uncreated' AND providerResourceName IS NULL`,
      )
      .run(userId, id, generation);
    if (result.changes !== 1)
      throw new CodespaceResourceError(
        "WORKSPACE_OUTCOME_UNCONFIRMED",
        "Original creation may already have been dispatched; collect its owner receipt",
      );
  }

  hasCurrentAuthorization(userId: string, id: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM githubResourceIdentity r
      JOIN codespaceConnection c ON c.id=r.connectionId AND c.userId=r.userId
      JOIN codespaceConnectionRepository g ON g.connectionId=c.id
      WHERE r.userId=? AND r.id=? AND r.revokedAt IS NULL
      AND c.provider='github-codespaces' AND c.status='connected'
      AND c.authorityGeneration=r.authorizationGeneration
      AND c.externalAccountId=r.externalOwnerId AND g.externalRepositoryId=r.repositoryId`,
        )
        .get(userId, id),
    );
  }

  reserve(identity: GitHubResourceIdentity): GitHubResourceIdentity {
    return this.db.transaction(() => {
      const prior = this.getOwned(identity.userId, identity.id);
      if (prior) {
        const keys = [
          "connectionId",
          "authorizationGeneration",
          "repositoryId",
          "repositoryFullName",
          "requestedRef",
          "devcontainerPath",
          "operationMarker",
          "externalOwnerId",
          "billableOwnerId",
          "deviceId",
          "deviceGeneration",
          "deviceConnectionId",
        ] as const;
        if (
          canonicalJson(keys.map((key) => prior[key])) !==
          canonicalJson(keys.map((key) => identity[key]))
        )
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Resource assignment identity changed",
          );
        return prior;
      }
      if (identity.providerResourceName) {
        const existing = this.db
          .prepare("SELECT id FROM githubResourceIdentity WHERE providerResourceName=?")
          .get(identity.providerResourceName) as { id: string } | undefined;
        if (existing)
          throw new CodespaceResourceError(
            "CODESPACE_GENERATION_CONFLICT",
            "Provider resource already has a public identity",
          );
      }
      this.db
        .prepare(
          `INSERT INTO githubResourceIdentity
        (id,userId,connectionId,authorizationGeneration,repositoryId,repositoryFullName,requestedRef,
         devcontainerPath,operationMarker,providerResourceName,externalOwnerId,billableOwnerId,deviceId,
         deviceGeneration,deviceConnectionId,generation,retirement,revokedAt,createdAt)
        VALUES (@id,@userId,@connectionId,@authorizationGeneration,@repositoryId,@repositoryFullName,@requestedRef,
          @devcontainerPath,@operationMarker,@providerResourceName,@externalOwnerId,@billableOwnerId,@deviceId,
          @deviceGeneration,@deviceConnectionId,@generation,@retirement,@revokedAt,@createdAt)`,
        )
        .run(identity);
      return identity;
    })();
  }

  advanceAuthority(
    userId: string,
    id: string,
    input: {
      resourceGeneration: number;
      authorizationGeneration: number;
      providerResourceName: string | null;
      retirement: GitHubResourceIdentity["retirement"];
    },
  ): GitHubResourceIdentity {
    return this.db.transaction(() => {
      const current = this.getOwned(userId, id);
      if (
        !current ||
        current.revokedAt !== null ||
        current.authorizationGeneration !== input.authorizationGeneration
      )
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Resource assignment authority changed",
        );
      if (input.resourceGeneration < current.generation)
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Resource authority generation changed",
        );
      if (
        current.providerResourceName &&
        current.providerResourceName !== input.providerResourceName
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Provider resource identity changed",
        );
      if (current.retirement === "retired" && input.retirement !== "retired")
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Retired resource authority cannot be restored",
        );
      if (input.retirement === "uncreated" && current.retirement !== "uncreated")
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Submitted creation cannot become uncreated",
        );
      if (input.retirement === "unknown" && current.retirement === "uncreated")
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Only the fixed provider broker can admit a billable creation",
        );
      this.db
        .prepare(
          `UPDATE githubResourceIdentity SET generation=@resourceGeneration,
        providerResourceName=@providerResourceName,retirement=@retirement WHERE userId=@userId AND id=@id`,
        )
        .run({ userId, id, ...input });
      return this.getOwned(userId, id)!;
    })();
  }
}
