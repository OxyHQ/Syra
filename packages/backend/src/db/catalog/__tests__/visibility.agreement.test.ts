/**
 * All THREE playability predicates agree on every row that can exist — proved
 * against real rows, not maintained by discipline.
 *
 * The three, and there are exactly three:
 *
 *  1. `playableTrackFilter()` — the SQL condition every catalog listing composes.
 *  2. `isPlayableTrack()` — its in-memory twin, for a row already loaded.
 *  3. `controllers/stream.controller.ts`'s `isTrackPlayable()` — the PLAYBACK
 *     authority, which decides whether a stream is issued at all.
 *
 * The third one is what makes this worth a test rather than a comment. Listing
 * and playback are separate authorities on purpose, so nothing structurally
 * forces them to agree — and when they disagree in the direction where listing
 * is looser, a taken-down track stays visible and searchable and then fails
 * under the listener's thumb.
 *
 * ## Why this test moved to the Postgres side
 *
 * Under Mongo the three did NOT agree, and the same test written there fails:
 * `playableTrackFilter` matched `isAvailable: true`, which a document with the
 * key ABSENT does not satisfy, while `isPlayableTrack` accepted
 * `isAvailable !== false`, which it does. Two of the nine
 * `{true, false, absent}²` shapes disagreed. `stream.controller`'s
 * `isTrackPlayable` was a third spelling (`!copyrightRemoved`) that diverges
 * from `copyrightRemoved !== true` on a truthy non-boolean.
 *
 * Fixing that in the Mongo code would have been work that evaporates — those
 * modules are deleted in Task 10c. The port closes both divergences
 * STRUCTURALLY: `tracks.is_available` and `tracks.copyright_removed` are
 * `NOT NULL` boolean columns, so "absent" and "truthy non-boolean" are
 * unrepresentable. That is the migration retiring a latent bug by construction
 * rather than by a comment telling the next person to keep two functions in
 * step.
 *
 * ## Fixtures that can tell a strict read from a loose one
 *
 * A test whose fixtures all sit on the same side of the distinction it exists to
 * make passes for the wrong reason — three live mutations have hidden behind
 * exactly that on this branch. The distinctions here are:
 *
 *  - `is_available` true vs false, and `copyright_removed` true vs false: all
 *    four combinations, so a predicate that drops either conjunct disagrees with
 *    the query on at least one row.
 *  - The shapes that are UNREPRESENTABLE are asserted to be unrepresentable
 *    rather than skipped — an explicit `null` insert on either column must be
 *    refused by the database. That is what makes "the port closed it
 *    structurally" a checked claim instead of a story about `NOT NULL`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, inArray, like, sql, type SQL } from 'drizzle-orm';
import { executeRows, sqlStateOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../../schema/catalog';
import { isTrackPlayable } from '../../../controllers/stream.controller';
import { isPlayableTrack, playableTrackFilter } from '../visibility';

/**
 * Everything this file inserts carries this prefix in its id, so teardown
 * removes exactly its own rows from a database other suites share.
 */
const MARKER = 'task10a-agreement';

const ARTIST_ID = `${MARKER}-artist`;

interface Shape {
  readonly id: string;
  readonly isAvailable: boolean;
  readonly copyrightRemoved: boolean;
}

/** All four combinations an actual row can hold. */
const SHAPES: readonly Shape[] = [true, false].flatMap((isAvailable) =>
  [true, false].map((copyrightRemoved) => ({
    id: `${MARKER}-available=${isAvailable}-removed=${copyrightRemoved}`,
    isAvailable,
    copyrightRemoved,
  }))
);

beforeAll(async () => {
  process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL;
  await connectPostgres();
  const db = getDb();

  await db
    .insert(catalogEntities)
    .values({ id: ARTIST_ID, type: 'artist', name: `${MARKER} artist`, source: 'upload' });

  await db.insert(tracks).values(
    SHAPES.map((shape) => ({
      id: shape.id,
      title: shape.id,
      artistId: ARTIST_ID,
      artistName: `${MARKER} artist`,
      duration: 180,
      source: 'upload' as const,
      status: 'ready' as const,
      isAvailable: shape.isAvailable,
      copyrightRemoved: shape.copyrightRemoved,
    }))
  );
});

afterAll(async () => {
  const db = getDb();
  await db.delete(tracks).where(like(tracks.id, `${MARKER}%`));
  await db.delete(albums).where(like(albums.id, `${MARKER}%`));
  await db.delete(catalogEntities).where(like(catalogEntities.id, `${MARKER}%`));
  await db.delete(imageAssets).where(like(imageAssets.id, `${MARKER}%`));
  await closePostgres();
});

describe('playableTrackFilter / isPlayableTrack agreement', () => {
  it('selects exactly the rows the in-memory predicate accepts', async () => {
    const db = getDb();

    const listed = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(playableTrackFilter(), like(tracks.id, `${MARKER}%`)));

    const stored = await db
      .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(like(tracks.id, `${MARKER}%`));

    expect(listed.map((row) => row.id).sort()).toEqual(
      stored.filter(isPlayableTrack).map((row) => row.id).sort()
    );
  });

  it('is not vacuous — the fixtures span both sides of the predicate', async () => {
    const db = getDb();

    const stored = await db
      .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(like(tracks.id, `${MARKER}%`));

    expect(stored).toHaveLength(4);
    const accepted = stored.filter(isPlayableTrack);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].id).toBe(`${MARKER}-available=true-removed=false`);
  });

  it('disagrees with a predicate that drops either conjunct', async () => {
    const db = getDb();

    const stored = await db
      .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(like(tracks.id, `${MARKER}%`));
    const listed = (
      await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(playableTrackFilter(), like(tracks.id, `${MARKER}%`)))
    )
      .map((row) => row.id)
      .sort();

    // The fixture set can tell the real predicate from either weakened one.
    // Without this, a predicate ignoring `copyright_removed` would still agree
    // with the query on every row the suite happened to insert, which is how a
    // surviving mutation looks from the inside.
    const ignoringRemoval = stored.filter((row) => row.isAvailable).map((row) => row.id).sort();
    const ignoringAvailability = stored
      .filter((row) => !row.copyrightRemoved)
      .map((row) => row.id)
      .sort();

    expect(ignoringRemoval).not.toEqual(listed);
    expect(ignoringAvailability).not.toEqual(listed);
  });
});

describe('the shapes the Mongo pair disagreed on are unrepresentable', () => {
  /**
   * SQLSTATE, not the message text. Drizzle wraps the driver error in one whose
   * own message is `Failed query: …` — matching on that would assert only that
   * SOMETHING went wrong, which is true of a typo in the fixture too. `23502` is
   * `not_null_violation` and `22P02` is `invalid_text_representation`; both are
   * structural facts about which guard fired.
   */
  async function sqlStateOfRefusal(statement: SQL): Promise<string | undefined> {
    try {
      await executeRows(getDb(), statement);
    } catch (error) {
      return sqlStateOf(error);
    }
    throw new Error('expected the write to be refused, but it succeeded');
  }

  /**
   * The Mongo query and predicate diverged only when `isAvailable` was ABSENT.
   * Postgres cannot store that, and this asserts it rather than assuming it —
   * if either column ever loses its `NOT NULL`, the divergence becomes
   * reachable again and this fails, which is the only warning anyone would get.
   */
  it('rejects a null is_available', async () => {
    expect(
      await sqlStateOfRefusal(
        sql`insert into ${tracks} (id, title, artist_id, artist_name, duration, source, status, is_available)
            values (${`${MARKER}-null-available`}, 'x', ${ARTIST_ID}, 'x', 1, 'upload', 'ready', null)`
      )
    ).toBe('23502');
  });

  it('rejects a null copyright_removed', async () => {
    expect(
      await sqlStateOfRefusal(
        sql`insert into ${tracks} (id, title, artist_id, artist_name, duration, source, status, copyright_removed)
            values (${`${MARKER}-null-removed`}, 'x', ${ARTIST_ID}, 'x', 1, 'upload', 'ready', null)`
      )
    ).toBe('23502');
  });

  it('rejects a non-boolean, the shape the two spellings of the predicate disagreed on', async () => {
    // `!x` and `x !== true` diverge on a truthy non-boolean such as the string
    // "false". The column type is what makes that unreachable, so the write is
    // refused before any predicate sees it.
    expect(
      await sqlStateOfRefusal(
        sql`insert into ${tracks} (id, title, artist_id, artist_name, duration, source, status, copyright_removed)
            values (${`${MARKER}-nonboolean`}, 'x', ${ARTIST_ID}, 'x', 1, 'upload', 'ready', 'not-a-boolean')`
      )
    ).toBe('22P02');
  });

  it('leaves nothing behind when those writes are refused', async () => {
    const leftovers = await getDb()
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inArray(tracks.id, [
          `${MARKER}-null-available`,
          `${MARKER}-null-removed`,
          `${MARKER}-nonboolean`,
        ])
      );

    expect(leftovers).toEqual([]);
  });
});

describe('the catalog and playback authorities cannot drift apart on a real row', () => {
  /**
   * The block name is now accurate, and Task 10c is why: `isTrackPlayable` is
   * imported from `controllers/stream.controller` and asserted here alongside
   * the catalog pair. Before that it was called "visibility.ts's own two
   * artefacts", deliberately, because the playback authority was still on
   * Mongoose and untested — a name claiming both authorities would have been the
   * same shape of defect as a comment claiming a guard that does not exist.
   *
   * What is checked: a row the query returns must be one BOTH predicates accept,
   * or a takedown stays listed and searchable and then fails at play. Checked in
   * the failing DIRECTION specifically, so a change making the query LOOSER than
   * either predicate is caught even if exact equality is relaxed for some other
   * reason.
   */
  it('never lists a row either predicate would refuse', async () => {
    const db = getDb();

    const listed = await db
      .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(and(playableTrackFilter(), like(tracks.id, `${MARKER}%`)));

    expect(listed.filter((row) => !isPlayableTrack(row))).toEqual([]);
    expect(listed.filter((row) => !isTrackPlayable(row))).toEqual([]);
    // And it did list something, so the assertions above are not trivially true.
    expect(listed.length).toBeGreaterThan(0);
  });

  /**
   * The stronger property, and the one the three-way split actually needs: on
   * EVERY representable row, all three answer the same thing. The assertion
   * above only covers rows the query returned, so a playback predicate that
   * refuses something extra — the direction that silently breaks play on a
   * listed track — passes it.
   */
  it('all three agree on every representable row', async () => {
    const stored = await getDb()
      .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(like(tracks.id, `${MARKER}%`));

    const listed = new Set(
      (
        await getDb()
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(playableTrackFilter(), like(tracks.id, `${MARKER}%`)))
      ).map((row) => row.id)
    );

    // One line per row naming all three answers, so a failure says WHICH row and
    // WHICH authority dissented rather than "expected [] to equal [X]".
    const verdicts = stored
      .map((row) =>
        `${row.id}: sql=${listed.has(row.id)} memory=${isPlayableTrack(row)} playback=${isTrackPlayable(row)}`
      )
      .sort();

    expect(verdicts).toEqual(
      stored
        .map((row) => {
          const expected = row.isAvailable && !row.copyrightRemoved;
          return `${row.id}: sql=${expected} memory=${expected} playback=${expected}`;
        })
        .sort()
    );
  });

  it('the removal of a track from the catalog is visible to both', async () => {
    const db = getDb();
    const playable = `${MARKER}-available=true-removed=false`;

    await db.update(tracks).set({ copyrightRemoved: true }).where(eq(tracks.id, playable));
    try {
      const listed = await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(playableTrackFilter(), eq(tracks.id, playable)));
      const [row] = await db
        .select({ id: tracks.id, isAvailable: tracks.isAvailable, copyrightRemoved: tracks.copyrightRemoved })
        .from(tracks)
        .where(eq(tracks.id, playable));

      expect(listed).toEqual([]);
      expect(isPlayableTrack(row)).toBe(false);
      // The takedown must reach playback too — this is the exact failure the
      // three-way agreement exists for.
      expect(isTrackPlayable(row)).toBe(false);
    } finally {
      await db.update(tracks).set({ copyrightRemoved: false }).where(eq(tracks.id, playable));
    }
  });
});
