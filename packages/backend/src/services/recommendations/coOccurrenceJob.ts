import { isPostgresConnected } from '../../db/postgres';
import { forEachMinableEvent } from '../../db/user/listening';
import { replaceRelationGraph, type RelationEdge, type RelationKind } from '../../db/user/relations';
import { logger } from '../../utils/logger';
import { PLAY_COMPLETION_THRESHOLD } from './engagement';

/**
 * Collaborative co-occurrence miner — the engine that learns which artists and
 * tracks "go together" from the aggregate behaviour of ALL users.
 *
 * Algorithm (a bounded, server-friendly item-item collaborative filter):
 *
 *  1. Scan recent, genuinely-listened events (completion ≥ threshold) grouped
 *     into per-user listening sessions split by an inactivity gap.
 *  2. Within each session, every unordered pair of distinct items co-occurs:
 *     increment a co-count for both `(a,b)` and the item self-counts.
 *  3. Convert co-counts to a normalised cosine-style similarity
 *     `score = coCount / sqrt(count[a] * count[b])`, which divides out raw
 *     popularity so a mega-popular artist doesn't dominate everyone's "related"
 *     list. Pairs below a support floor are dropped as noise.
 *  4. Keep the top-N targets per source and overwrite the `CatalogRelation`
 *     graph for that kind.
 *
 * The whole pass is bounded by event/window/pair caps so it stays predictable
 * on large catalogs; it runs under a distributed lock on a timer.
 */

/** Inactivity gap that ends a listening session (30 min, Spotify-like). */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Only mine the trailing window of events each pass. */
const LOOKBACK_DAYS = 60;

/** Hard cap on events scanned per pass to bound memory/time. */
const MAX_EVENTS = 500_000;

/** Minimum co-occurrence count for an edge to be trusted (noise floor). */
const MIN_CO_COUNT = 2;

/** Top related targets retained per source entity. */
const MAX_TARGETS_PER_SOURCE = 40;

interface MinedGraph {
  /** sourceId → (targetId → coCount) */
  pairs: Map<string, Map<string, number>>;
  /** entityId → number of sessions it appeared in */
  counts: Map<string, number>;
}

interface SessionItem {
  trackId: string;
  artistId: string;
}

export interface CoOccurrenceResult {
  artistEdges: number;
  trackEdges: number;
  sessions: number;
  events: number;
}

/**
 * Run one full co-occurrence pass and overwrite the relation graph. Safe to call
 * directly (e.g. from a CLI or test); the scheduler wraps it in a lock.
 */
export async function runCoOccurrencePass(): Promise<CoOccurrenceResult> {
  if (!isPostgresConnected()) {
    return { artistEdges: 0, trackEdges: 0, sessions: 0, events: 0 };
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const artistGraph: MinedGraph = { pairs: new Map(), counts: new Map() };
  const trackGraph: MinedGraph = { pairs: new Map(), counts: new Map() };

  let currentUser: string | null = null;
  let lastPlayedAt = 0;
  let session: SessionItem[] = [];
  let sessionCount = 0;

  const flush = () => {
    if (session.length > 1) {
      sessionCount++;
      foldSession(session, artistGraph, trackGraph);
    }
    session = [];
  };

  const eventCount = await forEachMinableEvent(
    { since, minCompletion: PLAY_COMPLETION_THRESHOLD, maxEvents: MAX_EVENTS },
    (event) => {
      const playedAt = event.playedAt.getTime();

      if (event.oxyUserId !== currentUser) {
        flush();
        currentUser = event.oxyUserId;
      } else if (playedAt - lastPlayedAt > SESSION_GAP_MS) {
        flush();
      }

      session.push({ trackId: event.trackId, artistId: event.artistId });
      lastPlayedAt = playedAt;
    }
  );
  flush();

  const artistEdges = await persistGraph('artist', artistGraph);
  const trackEdges = await persistGraph('track', trackGraph);

  logger.info('[recommendations] co-occurrence pass complete', {
    sessions: sessionCount,
    events: eventCount,
    artistEdges,
    trackEdges,
  });

  return { artistEdges, trackEdges, sessions: sessionCount, events: eventCount };
}

/**
 * Fold one session into both graphs: count each distinct artist/track once per
 * session (so replays within a session don't double-count), then increment all
 * unordered pairs.
 */
function foldSession(session: SessionItem[], artistGraph: MinedGraph, trackGraph: MinedGraph): void {
  const artists = Array.from(new Set(session.map((i) => i.artistId).filter(Boolean)));
  const tracks = Array.from(new Set(session.map((i) => i.trackId).filter(Boolean)));
  foldItems(artists, artistGraph);
  foldItems(tracks, trackGraph);
}

function foldItems(items: string[], graph: MinedGraph): void {
  for (const item of items) {
    graph.counts.set(item, (graph.counts.get(item) ?? 0) + 1);
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      addPair(graph.pairs, items[i], items[j]);
      addPair(graph.pairs, items[j], items[i]);
    }
  }
}

function addPair(pairs: Map<string, Map<string, number>>, a: string, b: string): void {
  let inner = pairs.get(a);
  if (!inner) {
    inner = new Map();
    pairs.set(a, inner);
  }
  inner.set(b, (inner.get(b) ?? 0) + 1);
}

/**
 * Compute normalised scores, keep the top targets per source, and overwrite the
 * relation collection for `kind`. The whole graph for the kind is replaced each
 * pass so stale edges never linger.
 */
async function persistGraph(kind: RelationKind, graph: MinedGraph): Promise<number> {
  const edges: RelationEdge[] = [];

  for (const [sourceId, targets] of graph.pairs) {
    const sourceCount = graph.counts.get(sourceId) ?? 0;
    if (sourceCount === 0) continue;

    const scored: RelationEdge[] = [];
    for (const [targetId, coCount] of targets) {
      if (coCount < MIN_CO_COUNT) continue;
      const targetCount = graph.counts.get(targetId) ?? 0;
      if (targetCount === 0) continue;
      const score = coCount / Math.sqrt(sourceCount * targetCount);
      scored.push({ sourceId, targetId, score, coCount });
    }

    scored.sort((a, b) => b.score - a.score);
    edges.push(...scored.slice(0, MAX_TARGETS_PER_SOURCE));
  }

  // Drop the previous graph for this kind, then write the fresh one — now in ONE
  // transaction (`replaceRelationGraph`), so readers see the old graph until the
  // new one commits instead of an empty one in between. The Mongo version's
  // `upsert: true` has nothing left to do once the two are atomic: after the
  // delete there is no row to conflict with.
  return replaceRelationGraph(kind, edges);
}
