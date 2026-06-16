import type { ExternalAlbum } from '@syra/shared-types';
import type { MusicSourceConnector } from './MusicSourceConnector';
import { AudiusConnector } from './AudiusConnector';
import { upsertArtist } from '../catalog/upsertArtist';
import { upsertTrack } from '../catalog/upsertTrack';
import { upsertAlbum } from '../catalog/upsertAlbum';
import { ArtistModel } from '../../models/Artist';
import { logger } from '../../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum gap between Audius imports for the same normalized query (10 min). */
const AUDIUS_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max Audius tracks fetched per background import pass. */
const AUDIUS_IMPORT_LIMIT = 20;

/** Default cap on the number of artists whose albums are synced per pass. */
const DEFAULT_MAX_ARTISTS_FOR_ALBUMS = 10;

/** Cap on the number of albums synced per artist per pass. */
const MAX_ALBUMS_PER_ARTIST = 10;

// ── Throttle map ──────────────────────────────────────────────────────────────

/**
 * Module-level map of normalized query → epoch ms of last completed import.
 * Used to prevent hammering Audius for repeated identical searches.
 */
const lastImportAt = new Map<string, number>();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// ── Deps interface ────────────────────────────────────────────────────────────

/**
 * Fetches an artist's albums (Audius-specific; not part of the shared
 * `MusicSourceConnector` interface). `AudiusConnector` implements this.
 */
export interface AlbumFetcher {
  fetchArtistAlbums(artistExternalId: string, limit?: number): Promise<ExternalAlbum[]>;
}

export interface AudiusImportDeps {
  /** Connector to use; defaults to `new AudiusConnector()`. */
  connector?: MusicSourceConnector;
  /**
   * Album fetcher used to sync each imported artist's albums. When omitted, no
   * album sync runs. The production entry point (`enqueueAudiusImport`) supplies
   * an `AudiusConnector` so albums are synced automatically.
   */
  albumFetcher?: AlbumFetcher;
  /** Cap on artists whose albums are synced per pass. Defaults to 10. */
  maxArtistsForAlbums?: number;
  /** Clock function; defaults to `Date.now`. Inject for testable throttling. */
  now?: () => number;
}

// ── Core import ───────────────────────────────────────────────────────────────

export interface AudiusImportResult {
  imported: number;
  skipped: boolean;
  /** Number of albums upserted into the catalog this pass. */
  albumsSynced: number;
}

/**
 * Search Audius for `query` and upsert all returned tracks + artists into the
 * catalog. Tracks are immediately playable (Audius → `status='ready'`,
 * `streamUrl` set by the connector).
 *
 * When an `albumFetcher` is supplied, after the tracks land we fetch each unique
 * imported artist's albums (bounded by `maxArtistsForAlbums` and
 * `MAX_ALBUMS_PER_ARTIST`) and upsert them, linking member tracks. Album sync is
 * best-effort: a failure for one artist or album is logged and skipped, never
 * aborting the pass.
 *
 * Throttled per normalized query: if the same query ran within
 * `AUDIUS_IMPORT_TTL_MS`, returns `{ imported: 0, skipped: true, albumsSynced: 0 }`.
 *
 * Per-track errors are isolated — one bad track does not abort the rest.
 */
export async function runAudiusImport(
  query: string,
  deps: AudiusImportDeps = {},
): Promise<AudiusImportResult> {
  const {
    connector = new AudiusConnector(),
    albumFetcher,
    maxArtistsForAlbums = DEFAULT_MAX_ARTISTS_FOR_ALBUMS,
    now = Date.now,
  } = deps;
  const key = normalizeQuery(query);

  const lastRun = lastImportAt.get(key);
  const currentTime = now();
  if (lastRun !== undefined && currentTime - lastRun < AUDIUS_IMPORT_TTL_MS) {
    return { imported: 0, skipped: true, albumsSynced: 0 };
  }
  lastImportAt.set(key, currentTime);

  const tracks = await connector.search(query, AUDIUS_IMPORT_LIMIT);

  let imported = 0;
  // Unique artist external ids, preserving first-seen order, for album sync.
  const artistExternalIds: string[] = [];
  const seenArtists = new Set<string>();
  for (const external of tracks) {
    try {
      await upsertArtist(external.artists[0], 'audius');
      await upsertTrack(external, 'audius');
      imported++;
      const artistExternalId = external.artists[0]?.externalId;
      if (artistExternalId && !seenArtists.has(artistExternalId)) {
        seenArtists.add(artistExternalId);
        artistExternalIds.push(artistExternalId);
      }
    } catch (err) {
      logger.warn('[audius-import] skipping track due to upsert error', {
        externalId: external.externalId,
        err,
      });
    }
  }

  const albumsSynced = albumFetcher
    ? await syncArtistAlbums(albumFetcher, artistExternalIds, maxArtistsForAlbums)
    : 0;

  logger.info('[audius-import] pass complete', {
    query: key,
    tracksImported: imported,
    artistsSeen: artistExternalIds.length,
    albumsSynced,
  });

  return { imported, skipped: false, albumsSynced };
}

/**
 * Sync albums for up to `maxArtists` imported artists. For each artist we look
 * up its persisted catalog doc (by audiusId), fetch its albums, and upsert each
 * (capped at MAX_ALBUMS_PER_ARTIST). Best-effort and fully isolated per artist
 * and per album.
 *
 * @returns the number of albums successfully upserted.
 */
async function syncArtistAlbums(
  albumFetcher: AlbumFetcher,
  artistExternalIds: string[],
  maxArtists: number,
): Promise<number> {
  const targets = artistExternalIds.slice(0, Math.max(0, maxArtists));
  let albumsSynced = 0;

  for (const artistExternalId of targets) {
    try {
      const artist = await ArtistModel.findOne({ 'externalIds.audiusId': artistExternalId });
      if (!artist) {
        logger.warn('[audius-import] album sync: artist not found in catalog', {
          artistExternalId,
        });
        continue;
      }

      const albums = await albumFetcher.fetchArtistAlbums(artistExternalId, MAX_ALBUMS_PER_ARTIST);
      const artistRef = { artistId: artist._id.toString(), artistName: artist.name };

      let skippedNoCover = 0;
      for (const album of albums.slice(0, MAX_ALBUMS_PER_ARTIST)) {
        try {
          const { album: saved } = await upsertAlbum(album, artistRef, 'audius');
          if (saved) {
            albumsSynced++;
          } else {
            skippedNoCover++;
          }
        } catch (err) {
          logger.warn('[audius-import] album sync: upsert failed', {
            artistExternalId,
            albumExternalId: album.externalId,
            err,
          });
        }
      }

      if (skippedNoCover > 0) {
        logger.info('[audius-import] album sync: skipped albums without cover art', {
          artistExternalId,
          skippedNoCover,
        });
      }
    } catch (err) {
      logger.warn('[audius-import] album sync: failed for artist', { artistExternalId, err });
    }
  }

  return albumsSynced;
}

// ── Fire-and-forget entry point ───────────────────────────────────────────────

/**
 * Fire-and-forget wrapper around `runAudiusImport`.
 *
 * - Blank/whitespace-only query: no-op.
 * - Connector errors and upsert failures are caught and logged; the caller
 *   is never affected.
 * - Never throws synchronously or asynchronously.
 *
 * Defaults a single `AudiusConnector` for BOTH search and album fetching so the
 * production path syncs albums automatically (zero-config). Tests that pass an
 * explicit `connector`/`albumFetcher` keep full control.
 */
export function enqueueAudiusImport(query: string, deps?: AudiusImportDeps): void {
  if (!query.trim()) return;

  const audius = new AudiusConnector();
  const resolvedDeps: AudiusImportDeps = {
    connector: audius,
    albumFetcher: audius,
    ...deps,
  };

  runAudiusImport(query, resolvedDeps).catch((err: unknown) => {
    logger.error('[audius-import] failed', { query, err });
  });
}
