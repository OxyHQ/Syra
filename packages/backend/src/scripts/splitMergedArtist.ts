/**
 * Split one artist row that is really several people into the real ones.
 *
 * Uploads before the acoustic credit fix collapsed a multi-artist recording into
 * a single entity whose NAME contained the join — `benny blanco, Bb trickz`. The
 * cause is fixed; the rows it already made are not, and they cannot be fixed by
 * re-uploading: the audio is in S3 and the tracks are live and playable.
 *
 * ## The split is stated, never inferred
 *
 * The script takes the names as arguments. It does not parse the merged name,
 * and that is the point — a comma is not evidence. `Earth, Wind & Fire` is one
 * artist, and a repair that guessed would be the comma-splitting mistake wearing
 * a different hat. A person decides; this only executes it safely.
 *
 * ## What it does
 *
 * The FIRST name given becomes the principal: every track pointing at the merged
 * row is re-pointed at it. The rest become featured credits on those same
 * tracks, carrying their new entity ids. The merged row is then deleted, but
 * only once nothing references it — checked, not assumed.
 *
 * Idempotent. Run it twice and the second run finds no tracks to move and no row
 * to delete, and says so.
 *
 * Usage:
 *   bun run src/scripts/splitMergedArtist.ts <entityId> "First Artist" "Second" [...]
 */
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeNameKey } from '@syra/shared-types';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { albums, catalogEntities, trackCredits, tracks } from '../db/schema/catalog';
import { ensureContributedArtist } from '../services/uploads/resolveArtist';
import { describeErrorSafely } from '../utils/error';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const [entityId, ...names] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

  if (!entityId || names.length < 2) {
    throw new Error(
      'Usage: splitMergedArtist.ts <entityId> "First Artist" "Second Artist" [...] — ' +
        'at least two names, and the FIRST becomes the principal.',
    );
  }

  await connectPostgres();
  try {
    const db = getDb();

    const [merged] = await db
      .select({ id: catalogEntities.id, name: catalogEntities.name })
      .from(catalogEntities)
      .where(eq(catalogEntities.id, entityId))
      .limit(1);

    if (!merged) {
      logger.info(`Nothing to do: no catalog entity ${entityId}. Already split?`);
      return;
    }

    logger.info(`Splitting "${merged.name}" into: ${names.join(' | ')}`);

    // Created before anything moves: if a name is denylisted or unusable,
    // `ensureContributedArtist` returns null and the run must stop BEFORE it has
    // re-pointed a track at an artist that does not exist.
    const created: Array<{ id: string; name: string }> = [];
    for (const name of names) {
      const artist = await ensureContributedArtist({ name });
      if (!artist) throw new Error(`Refused to create an artist for "${name}" — cannot continue`);
      created.push({ id: artist.id, name: artist.name });
    }

    const principal = created[0];
    if (!principal) throw new Error('unreachable: at least two names were required');
    const featured = created.slice(1);

    const owned = await db
      .select({ id: tracks.id, title: tracks.title })
      .from(tracks)
      .where(eq(tracks.artistId, entityId));

    logger.info(`${owned.length} track(s) point at the merged row`);

    await db.transaction(async (tx) => {
      for (const track of owned) {
        await tx
          .update(tracks)
          .set({ artistId: principal.id, artistName: principal.name })
          .where(eq(tracks.id, track.id));

        for (const [index, artist] of featured.entries()) {
          const nameKey = normalizeNameKey(artist.name);
          // The credit may already exist from a previous run or from a later
          // upload of the same recording; `(track, nameKey, role)` is what makes
          // it the same credit.
          const [existing] = await tx
            .select({ id: trackCredits.id })
            .from(trackCredits)
            .where(
              and(
                eq(trackCredits.trackId, track.id),
                eq(trackCredits.nameKey, nameKey),
                eq(trackCredits.role, 'artist'),
              ),
            )
            .limit(1);
          if (existing) continue;

          await tx.insert(trackCredits).values({
            trackId: track.id,
            position: index,
            name: artist.name,
            nameKey,
            role: 'artist',
            catalogEntityId: artist.id,
          });
        }
        logger.info(`  "${track.title}" -> ${principal.name} (+${featured.length} credited)`);
      }

      // Albums carry their own `artistId`, and leaving one pointing at a row
      // about to be deleted is how a foreign key becomes a 23503 at the delete
      // rather than a bug someone finds later.
      await tx
        .update(albums)
        .set({ artistId: principal.id, artistName: principal.name })
        .where(eq(albums.artistId, entityId));
    });

    // Checked, not assumed: anything still pointing here means the split is
    // incomplete, and deleting would either fail loudly or orphan real rows.
    const [stillTracked] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.artistId, entityId))
      .limit(1);
    const [stillAlbum] = await db
      .select({ id: albums.id })
      .from(albums)
      .where(eq(albums.artistId, entityId))
      .limit(1);
    const [stillCredited] = await db
      .select({ id: trackCredits.id })
      .from(trackCredits)
      .where(eq(trackCredits.catalogEntityId, entityId))
      .limit(1);

    if (stillTracked || stillAlbum || stillCredited) {
      logger.warn('Merged row still referenced — left in place deliberately', {
        tracks: Boolean(stillTracked),
        albums: Boolean(stillAlbum),
        credits: Boolean(stillCredited),
      });
      return;
    }

    if (created.some((artist) => artist.id === entityId)) {
      // One of the requested names normalised to the merged row itself. Deleting
      // it would delete an artist we just re-pointed everything AT.
      logger.info('Merged row IS one of the split results — keeping it.');
      return;
    }

    await db.delete(catalogEntities).where(inArray(catalogEntities.id, [entityId]));
    logger.info(`Deleted the merged row "${merged.name}"`);
  } finally {
    await closePostgres();
  }
}

void main().catch((error: unknown) => {
  logger.error('Split failed', { err: describeErrorSafely(error) });
  process.exitCode = 1;
});
