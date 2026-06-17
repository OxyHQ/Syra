import type { ExternalAlbum, ExternalPlaylist, ExternalTrack } from '@syra/shared-types';
import type { MusicSourceConnector } from './MusicSourceConnector';
import { AudiusConnector } from './AudiusConnector';
import { upsertTrack } from '../catalog/upsertTrack';
import { prepareAlbumCover, upsertAlbum } from '../catalog/upsertAlbum';
import { preparePlaylistCover, upsertPlaylist } from '../catalog/upsertPlaylist';
import { syncAlbumsForTracks } from '../catalog/syncTrackAlbums';
import { ArtistModel } from '../../models/Artist';
import { logger } from '../../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum gap between Audius imports for the same normalized query (10 min). */
const AUDIUS_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max Audius tracks fetched per background import pass. */
const AUDIUS_IMPORT_LIMIT = 8;

/** Default cap on the number of artists whose albums are synced per pass. */
const DEFAULT_MAX_ARTISTS_FOR_ALBUMS = 2;

/** Cap on the number of albums synced per artist per pass. */
const MAX_ALBUMS_PER_ARTIST = 3;

/** Cap on the number of playlists synced per artist per pass. */
const MAX_PLAYLISTS_PER_ARTIST = 3;

// ── Throttle map ──────────────────────────────────────────────────────────────

/**
 * Module-level map of normalized query → epoch ms of last completed import.
 * Used to prevent hammering Audius for repeated identical searches.
 */
const lastImportAt = new Map<string, number>();
const queuedImports = new Set<string>();
let importQueue: Promise<void> = Promise.resolve();

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

/**
 * Fetches an artist's non-album playlists (Audius-specific).
 */
export interface PlaylistFetcher {
  fetchArtistPlaylists(artistExternalId: string, limit?: number): Promise<ExternalPlaylist[]>;
}

function isAlbumFetcher(value: unknown): value is AlbumFetcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { fetchArtistAlbums?: unknown }).fetchArtistAlbums === 'function'
  );
}

function isPlaylistFetcher(value: unknown): value is PlaylistFetcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { fetchArtistPlaylists?: unknown }).fetchArtistPlaylists === 'function'
  );
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
  /** Playlist fetcher used to sync each imported artist's non-album playlists. */
  playlistFetcher?: PlaylistFetcher;
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
  /** Number of playlists upserted into the catalog this pass. */
  playlistsSynced: number;
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
    playlistFetcher,
    maxArtistsForAlbums = DEFAULT_MAX_ARTISTS_FOR_ALBUMS,
    now = Date.now,
  } = deps;
  const key = normalizeQuery(query);

  const lastRun = lastImportAt.get(key);
  const currentTime = now();
  if (lastRun !== undefined && currentTime - lastRun < AUDIUS_IMPORT_TTL_MS) {
    return { imported: 0, skipped: true, albumsSynced: 0, playlistsSynced: 0 };
  }
  lastImportAt.set(key, currentTime);

  const tracks = await connector.search(query, AUDIUS_IMPORT_LIMIT);

  let imported = 0;
  const importedTracks: ExternalTrack[] = [];
  // Unique artist external ids, preserving first-seen order, for album sync.
  const artistExternalIds: string[] = [];
  const seenArtists = new Set<string>();
  for (const external of tracks) {
    try {
      const { track } = await upsertTrack(external, 'audius');
      if (!track) continue;
      importedTracks.push(external);
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

  const albumsFromTracks = await syncAlbumsForTracks(importedTracks, 'audius');
  const albumsFromArtists = albumFetcher
    ? await syncArtistAlbums(albumFetcher, artistExternalIds, maxArtistsForAlbums)
    : 0;
  const albumsSynced = albumsFromTracks + albumsFromArtists;
  const playlistsSynced = playlistFetcher
    ? await syncArtistPlaylists(playlistFetcher, artistExternalIds, maxArtistsForAlbums)
    : 0;

  logger.info('[audius-import] pass complete', {
    query: key,
    tracksImported: imported,
    artistsSeen: artistExternalIds.length,
    albumsSynced,
    playlistsSynced,
  });

  return { imported, skipped: false, albumsSynced, playlistsSynced };
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
      let skippedEmpty = 0;
      for (const album of albums.slice(0, MAX_ALBUMS_PER_ARTIST)) {
        try {
          const preparedCover = await prepareAlbumCover(album, 'audius');
          if (!preparedCover) {
            skippedNoCover++;
            continue;
          }

          for (const track of album.tracks ?? []) {
            await upsertTrack(track, 'audius');
          }

          const { album: saved } = await upsertAlbum(album, artistRef, 'audius', preparedCover);
          if (saved) {
            albumsSynced++;
          } else {
            skippedEmpty++;
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
      if (skippedEmpty > 0) {
        logger.info('[audius-import] album sync: skipped albums without resolved tracks', {
          artistExternalId,
          skippedEmpty,
        });
      }
    } catch (err) {
      logger.warn('[audius-import] album sync: failed for artist', { artistExternalId, err });
    }
  }

  return albumsSynced;
}

async function syncArtistPlaylists(
  playlistFetcher: PlaylistFetcher,
  artistExternalIds: string[],
  maxArtists: number,
): Promise<number> {
  const targets = artistExternalIds.slice(0, Math.max(0, maxArtists));
  let playlistsSynced = 0;

  for (const artistExternalId of targets) {
    try {
      const playlists = await playlistFetcher.fetchArtistPlaylists(
        artistExternalId,
        MAX_PLAYLISTS_PER_ARTIST,
      );

      let skippedNoCover = 0;
      let skippedEmpty = 0;
      for (const playlist of playlists.slice(0, MAX_PLAYLISTS_PER_ARTIST)) {
        try {
          const preparedCover = await preparePlaylistCover(playlist, 'audius');
          if (!preparedCover) {
            skippedNoCover++;
            continue;
          }

          for (const track of playlist.tracks ?? []) {
            await upsertTrack(track, 'audius');
          }

          const { playlist: saved } = await upsertPlaylist(playlist, 'audius', preparedCover);
          if (saved) {
            playlistsSynced++;
          } else {
            skippedEmpty++;
          }
        } catch (err) {
          logger.warn('[audius-import] playlist sync: upsert failed', {
            artistExternalId,
            playlistExternalId: playlist.externalId,
            err,
          });
        }
      }
      if (skippedNoCover > 0) {
        logger.info('[audius-import] playlist sync: skipped playlists without cover art', {
          artistExternalId,
          skippedNoCover,
        });
      }
      if (skippedEmpty > 0) {
        logger.info('[audius-import] playlist sync: skipped playlists without resolved tracks', {
          artistExternalId,
          skippedEmpty,
        });
      }
    } catch (err) {
      logger.warn('[audius-import] playlist sync: failed for artist', { artistExternalId, err });
    }
  }

  return playlistsSynced;
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
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return;
  if (queuedImports.has(normalizedQuery)) return;
  queuedImports.add(normalizedQuery);

  importQueue = importQueue
    .catch(() => {
      // Keep the queue alive after a previous fire-and-forget failure.
    })
    .then(async () => {
      const audius = new AudiusConnector();
      const connector = deps?.connector ?? audius;
      const resolvedDeps: AudiusImportDeps = {
        connector,
        albumFetcher: deps?.albumFetcher ?? (isAlbumFetcher(connector) ? connector : undefined),
        playlistFetcher: deps?.playlistFetcher ?? (isPlaylistFetcher(connector) ? connector : undefined),
        ...deps,
      };

      try {
        await runAudiusImport(normalizedQuery, resolvedDeps);
      } catch (err: unknown) {
        logger.error('[audius-import] failed', { query: normalizedQuery, err });
      } finally {
        queuedImports.delete(normalizedQuery);
      }
    });
}
