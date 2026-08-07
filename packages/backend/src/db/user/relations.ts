/**
 * `catalog_relations` — the precomputed co-listen graph, on drizzle.
 *
 * One row per relatedness edge, mined from every listener's sessions by
 * `services/recommendations/coOccurrenceJob.ts` and read by every "fans also
 * listened to" surface. A fully regenerable cache: the job replaces the whole
 * graph for a kind each pass, so an edge is never repaired, only rewritten.
 *
 * ## Polymorphic by `kind`, so neither id column has a foreign key
 *
 * `source_id`/`target_id` hold a `tracks` id under `kind = 'track'` and a
 * `catalog_entities` id under `kind = 'artist'`. Postgres has no conditional
 * foreign key, so both are plain `text` — which is also why no reader needs an
 * id-shape guard: an edge pointing at a row that no longer exists simply matches
 * nothing when the caller looks the id up. The Mongo readers had to drop
 * non-`ObjectId` values first or the `$in` would throw.
 *
 * ## The rewrite is a truncate-and-insert inside one transaction
 *
 * `persistGraph` used `deleteMany({ kind })` followed by batched `bulkWrite`
 * upserts, and the gap between the two was a window in which every "related"
 * shelf for that kind was empty. One transaction closes it: readers see the old
 * graph until the new one commits. The upsert half of the Mongo version has
 * nothing left to do once the delete and the insert are atomic — after the
 * delete there is nothing to conflict with — so this inserts outright and the
 * unique constraint stays as the invariant it always was rather than a
 * conflict target.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { CATALOG_RELATION_KINDS, catalogRelations } from '../schema/user';

export type RelationKind = (typeof CATALOG_RELATION_KINDS)[number];

/** One mined edge, as the job produces it. */
export interface RelationEdge {
  sourceId: string;
  targetId: string;
  score: number;
  coCount: number;
}

/** Rows per INSERT while rewriting a graph, bounding statement size. */
const WRITE_BATCH = 1_000;

/**
 * The top edges out of one or more sources, best score first.
 *
 * `desc(score)` matches the direction of
 * `catalog_relations_kind_source_id_score_idx`, and `score` is `notNull()`, so
 * the `NULLS FIRST` inversion Postgres applies to a descending sort has no null
 * branch to hoist above the real rows.
 *
 * Callers that pass several sources sum the scores per target themselves, which
 * is why this returns edges rather than an aggregate: `radioPools` weights a
 * target by how many of the station's sources reach it, and that count is lost
 * by any aggregation done here.
 */
export async function findRelatedEdges(
  kind: RelationKind,
  sourceIds: string[],
  limit: number,
  db: DbOrTransaction = getDb(),
): Promise<{ targetId: string; score: number }[]> {
  if (sourceIds.length === 0) return [];

  return db
    .select({ targetId: catalogRelations.targetId, score: catalogRelations.score })
    .from(catalogRelations)
    .where(
      and(
        eq(catalogRelations.kind, kind),
        // `inArray` even for a single source: `= 'x'` and `in ('x')` plan
        // identically here, and one code path cannot drift from the other.
        inArray(catalogRelations.sourceId, sourceIds),
      ),
    )
    .orderBy(desc(catalogRelations.score))
    .limit(limit);
}

/**
 * Replace the entire graph for one kind.
 *
 * Atomic by construction — see this file's doc comment. An empty `edges` still
 * performs the delete, because "this pass mined nothing" and "leave last pass's
 * edges in place" are different outcomes and the job means the first.
 */
export async function replaceRelationGraph(
  kind: RelationKind,
  edges: RelationEdge[],
): Promise<number> {
  return getDb().transaction(async (tx) => {
    await tx.delete(catalogRelations).where(eq(catalogRelations.kind, kind));

    const computedAt = new Date();
    for (let i = 0; i < edges.length; i += WRITE_BATCH) {
      await tx.insert(catalogRelations).values(
        edges.slice(i, i + WRITE_BATCH).map((edge) => ({
          kind,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          score: edge.score,
          coCount: edge.coCount,
          computedAt,
        })),
      );
    }

    return edges.length;
  });
}
