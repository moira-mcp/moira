import type Database from "better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { CodespaceResourceError } from "./resource-types.js";
import { controllerRequestIdSchema } from "./local-controller-protocol.js";

/** Immutable Local route identity. Physical state and operation receipts are owner-held. */
interface LocalResourceRoute {
  id: string;
  userId: string;
  connectionId: string;
  authorizationGeneration: number;
  repositoryId: string;
  repositoryFullName: string;
  requestedRef: string;
  operationMarker: string;
  routeGeneration: number;
  createdAt: number;
}
export type LocalResourceIdentity = LocalResourceRoute &
  (
    | { retiredAt: null; retiredGeneration: null; retiredRequestId: null }
    | { retiredAt: number; retiredGeneration: number; retiredRequestId: string | null }
  );

export class LocalResourceRepository {
  constructor(readonly db: Database.Database) {}
  getOwned(userId: string, id: string): LocalResourceIdentity | null {
    return (
      (this.db
        .prepare("SELECT * FROM localResourceIdentity WHERE userId=? AND id=?")
        .get(userId, id) as LocalResourceIdentity | undefined) ?? null
    );
  }
  listOwned(userId: string): LocalResourceIdentity[] {
    return this.db
      .prepare("SELECT * FROM localResourceIdentity WHERE userId=? ORDER BY createdAt,id")
      .all(userId) as LocalResourceIdentity[];
  }
  reserve(identity: LocalResourceIdentity): LocalResourceIdentity {
    return this.db
      .transaction(() => {
        const existing = this.getOwned(identity.userId, identity.id);
        if (existing) {
          const immutable = ({
            retiredAt: _at,
            retiredGeneration: _generation,
            retiredRequestId: _request,
            createdAt: _created,
            ...value
          }: LocalResourceIdentity) => value;
          if (canonicalJson(immutable(existing)) !== canonicalJson(immutable(identity)))
            throw new CodespaceResourceError(
              "CODESPACE_GENERATION_CONFLICT",
              "Local route identity changed",
            );
          return existing;
        }
        this.db
          .prepare(
            `INSERT INTO localResourceIdentity
        (id,userId,connectionId,authorizationGeneration,repositoryId,repositoryFullName,requestedRef,operationMarker,routeGeneration,createdAt,retiredAt,retiredGeneration,retiredRequestId)
        VALUES (@id,@userId,@connectionId,@authorizationGeneration,@repositoryId,@repositoryFullName,@requestedRef,@operationMarker,@routeGeneration,@createdAt,@retiredAt,@retiredGeneration,@retiredRequestId)`,
          )
          .run(identity);
        return identity;
      })
      .immediate();
  }
  retire(
    userId: string,
    id: string,
    proof: { requestId: string; resourceGeneration: number; retiredAt: number },
  ): void {
    controllerRequestIdSchema.parse(proof.requestId);
    if (
      !Number.isSafeInteger(proof.resourceGeneration) ||
      proof.resourceGeneration < 1 ||
      !Number.isSafeInteger(proof.retiredAt) ||
      proof.retiredAt < 0
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Invalid owner retirement witness",
      );
    const current = this.getOwned(userId, id);
    if (!current)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Local identity unavailable");
    if (current.retiredAt !== null) {
      if (
        current.retiredRequestId !== proof.requestId ||
        current.retiredGeneration !== proof.resourceGeneration
      )
        throw new CodespaceResourceError(
          "CODESPACE_GENERATION_CONFLICT",
          "Local route is already retired",
        );
      return;
    }
    this.db
      .prepare(
        "UPDATE localResourceIdentity SET retiredAt=?,retiredGeneration=?,retiredRequestId=? WHERE userId=? AND id=? AND retiredAt IS NULL",
      )
      .run(proof.retiredAt, proof.resourceGeneration, proof.requestId, userId, id);
  }
}
