import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../schema.js";
import type { AnalyticsQuery, AnalyticsScope } from "../../types/admin-analytics.js";
import { analyticsScope, includedAnalyticsUser } from "../admin-analytics-query.js";
import { withDrizzleWrite } from "../drizzle-write.js";
import { storedTimestampMs } from "../timestamp-sql.js";

export const PUBLICATION_VISIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PublicationLink = typeof schema.publicationLink.$inferSelect;
export type PublicationInput = Omit<PublicationLink, "id">;
export type PublicationReportRow = Omit<PublicationInput, "language"> & {
  id: string | null;
  language: PublicationInput["language"] | null;
  visits: number;
  registered: number;
  firstRun: number;
  repeatRun: number;
};
export interface PublicationReport {
  scope: AnalyticsScope;
  rows: PublicationReportRow[];
}

function visitDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PublicationRepository {
  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private clock: () => number = Date.now,
  ) {}

  async create(input: PublicationInput): Promise<PublicationLink> {
    const { campaign, source, publication, language } = input;
    const id = randomUUID();
    return withDrizzleWrite(this.db, () =>
      this.db.get<PublicationLink>(sql`
      INSERT INTO publicationLink(id,campaign,source,publication,language)
      VALUES (${id},${campaign},${source},${publication},${language})
      RETURNING id,campaign,source,publication,language`)!,
    );
  }

  exists(id: string): boolean {
    return !!this.db.get(sql`SELECT 1 FROM publicationLink WHERE id=${id}`);
  }

  async accept(id: string): Promise<string | null> {
    return withDrizzleWrite(this.db, () => {
      const now = this.clock();
      this.db.run(sql`UPDATE publicationVisit SET tokenDigest=NULL
        WHERE tokenDigest IS NOT NULL AND acceptedAt<=${now - PUBLICATION_VISIT_TTL_MS}`);
      const token = randomBytes(32).toString("base64url");
      const inserted = this.db
        .run(sql`INSERT INTO publicationVisit(publicationId,acceptedAt,tokenDigest)
        SELECT id,${now},${visitDigest(token)} FROM publicationLink WHERE id=${id}`);
      return inserted.changes ? token : null;
    });
  }

  /** Called only on confirmed new-account creation. Consuming the token and binding the account are atomic. */
  async attribute(token: string, userId: string): Promise<void> {
    await withDrizzleWrite(this.db, () => {
      const now = this.clock();
      const visit = this.db.get<{
        publicationId: string;
      }>(sql`UPDATE publicationVisit SET tokenDigest=NULL
        WHERE tokenDigest=${visitDigest(token)} AND acceptedAt>${now - PUBLICATION_VISIT_TTL_MS}
        AND acceptedAt<=${now} RETURNING publicationId`);
      if (visit)
        this.db.run(sql`INSERT INTO publicationRegistration(userId,publicationId)
        VALUES (${userId},${visit.publicationId}) ON CONFLICT(userId) DO NOTHING`);
    });
  }

  report(query: AnalyticsQuery): PublicationReport {
    return this.db.transaction((tx) => {
      const scope = analyticsScope(tx, query, this.clock());
      const registrationTime = storedTimestampMs(sql`u.createdAt`);
      const runs = sql`SELECT 1 FROM workflowExecution e
        WHERE e.userId=u.id AND e.createdAt<${scope.endAt}`;
      const rows = tx.all<PublicationReportRow>(sql`
        WITH cohort AS (
          SELECT a.publicationId, count(*) AS registered,
            sum(EXISTS(${runs} LIMIT 1)) AS firstRun,
            sum(EXISTS(${runs} LIMIT 1 OFFSET 1)) AS repeatRun
          FROM user u LEFT JOIN publicationRegistration a ON a.userId=u.id
          WHERE ${registrationTime}>=${scope.startAt} AND ${registrationTime}<${scope.endAt}
            AND ${includedAnalyticsUser(query)}
          GROUP BY a.publicationId
        ), links AS (
          SELECT id,campaign,source,publication,language FROM publicationLink
          UNION ALL SELECT NULL,'','','',NULL
        )
        SELECT p.id,p.campaign,p.source,p.publication,p.language,
          (SELECT count(*) FROM publicationVisit v WHERE v.publicationId=p.id
            AND v.acceptedAt>=${scope.startAt} AND v.acceptedAt<${scope.endAt}) AS visits,
          coalesce(c.registered,0) AS registered,coalesce(c.firstRun,0) AS firstRun,
          coalesce(c.repeatRun,0) AS repeatRun
        FROM links p LEFT JOIN cohort c ON c.publicationId IS p.id
        ORDER BY p.id IS NULL,p.campaign,p.source,p.publication,p.id`);
      return { scope, rows };
    });
  }
}
