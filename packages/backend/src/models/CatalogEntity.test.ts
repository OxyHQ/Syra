import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { normalizeNameKey } from '@syra/shared-types';
import { CatalogEntityModel, ArtistModel, PersonModel } from './CatalogEntity';
import { isDuplicateKeyOn, duplicateKeyFields } from '../utils/duplicateKey';

beforeAll(connect);

/**
 * Build BOTH discriminators' indexes before EVERY test, with `createIndexes()`.
 *
 * All THREE models, because each one only knows its own indexes: the base model
 * builds `linkedOxyUserId_1`/`href_1`, and only the discriminators build
 * `nameKey_1` and `externalIds.musicbrainzArtistId_1`.
 *
 * Not `syncIndexes()`: the three share one physical collection but each schema
 * lists only its own indexes, so `syncIndexes()` on any of them DROPS the
 * others'. Mongoose's background `autoIndex` then rebuilds them a moment later,
 * so a uniqueness assertion made after a `syncIndexes()` call passes or fails on
 * timing rather than on the constraint. `createIndexes()` only builds.
 *
 * And per test, not once per file: the whole suite shares one mongod and other
 * files DROP `catalogentities` outright, which takes every index with it — so a
 * uniqueness test has to (re)build what it asserts on rather than inherit it.
 * `createIndexes()` is idempotent, so the rebuild is a no-op the rest of the time.
 */
beforeEach(async () => {
  await CatalogEntityModel.createIndexes();
  await ArtistModel.createIndexes();
  await PersonModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

describe('CatalogEntity discriminator', () => {
  it('artists and persons live in ONE collection but stay type-scoped', async () => {
    await ArtistModel.create({ name: 'The Band', source: 'cc' });
    await PersonModel.create({ name: 'Jane Host' });

    // Same physical collection.
    expect(ArtistModel.collection.name).toBe('catalogentities');
    expect(PersonModel.collection.name).toBe('catalogentities');
    expect(CatalogEntityModel.collection.name).toBe('catalogentities');

    // The discriminator auto-injects the `type` filter into find().
    const artists = await ArtistModel.find({}).lean();
    expect(artists).toHaveLength(1);
    expect(artists[0]?.name).toBe('The Band');
    expect(artists[0]?.type).toBe('artist');

    const persons = await PersonModel.find({}).lean();
    expect(persons).toHaveLength(1);
    expect(persons[0]?.name).toBe('Jane Host');
    expect(persons[0]?.type).toBe('person');

    // Base model sees BOTH.
    const all = await CatalogEntityModel.find({}).lean();
    expect(all).toHaveLength(2);
  });

  it('ArtistModel.find() never returns person docs (and vice-versa)', async () => {
    await PersonModel.create({ name: 'Only A Person' });

    // An un-filtered artist query must NOT leak the person.
    expect(await ArtistModel.find({}).lean()).toHaveLength(0);
    expect(await ArtistModel.countDocuments({})).toBe(0);
    expect(await PersonModel.find({}).lean()).toHaveLength(1);
  });

  it('persons strong-key dedup: one entity per linkedOxyUserId (sparse-unique)', async () => {
    await PersonModel.create({ name: 'Oxy User', linkedOxyUserId: 'oxy-1' });
    await expect(
      PersonModel.create({ name: 'Oxy User Dup', linkedOxyUserId: 'oxy-1' }),
    ).rejects.toThrow();
  });

  it('derives nameKey from name on every write', async () => {
    // A unique index over a field each caller fills for itself constrains only
    // whatever those callers happened to agree on. Deriving it in the schema is
    // what makes the index guard something real.
    const artist = await ArtistModel.create({ name: 'Sigur Rós', source: 'upload' });
    expect(artist.nameKey).toBe('sigur ros');

    const person = await PersonModel.create({ name: 'Ramón O’Brien' });
    expect(person.nameKey).toBe(normalizeNameKey('Ramón O’Brien'));

    // A caller-supplied value is overwritten, not trusted — a hand-written
    // nameKey is either the same value or a bug.
    const lying = await ArtistModel.create({ name: 'Portishead', nameKey: 'something-else', source: 'upload' });
    expect(lying.nameKey).toBe('portishead');
  });

  it('recomputes nameKey when the name is renamed', async () => {
    const artist = await ArtistModel.create({ name: 'Old Name', source: 'upload' });
    artist.name = 'Café Tacvba';
    await artist.save();

    expect(artist.nameKey).toBe('cafe tacvba');
  });

  it('artists dedup by nameKey: one artist per normalised name', async () => {
    await ArtistModel.create({ name: 'Los Ángeles', source: 'upload' });

    // Two uploads naming the same artist race to insert; only the index can
    // decide. Without this the catalog gains a permanent duplicate.
    await expect(
      ArtistModel.create({ name: 'Los Angeles', source: 'upload' }),
    ).rejects.toThrow();
  });

  it('surfaces a nameKey collision as a typed conflict the caller can recover from', async () => {
    const winner = await ArtistModel.create({ name: 'Boards of Canada', source: 'upload' });

    // The E11000 is the ANSWER, not a failure: the loser reads which key it lost
    // on and uses the winner's row. A bare `code === 11000` cannot tell this
    // apart from a collision on an index the caller never expected, which is a
    // bug that must not be swallowed.
    let recovered: string | undefined;
    try {
      await ArtistModel.create({ name: 'boards of canada', source: 'upload' });
    } catch (err) {
      expect(duplicateKeyFields(err)).toEqual(['nameKey']);
      expect(isDuplicateKeyOn(err, 'nameKey')).toBe(true);
      // An UNEXPECTED key must not look recoverable.
      expect(isDuplicateKeyOn(err, 'externalIds.musicbrainzArtistId')).toBe(false);
      if (isDuplicateKeyOn(err, 'nameKey')) {
        const existing = await ArtistModel.findOne({ nameKey: 'boards of canada' }).lean();
        recovered = existing?._id.toString();
      }
    }
    expect(recovered).toBe(winner._id.toString());
  });

  it('refuses to create an artist from a tagger placeholder', async () => {
    // The single path by which a catalog fills with irreversible garbage: once
    // an "Unknown Artist" row exists, every untagged upload attaches to it and
    // the recordings underneath can never be split apart again.
    for (const name of ['Unknown Artist', 'Various Artists', 'VA', '[unknown]', 'Varios artistas']) {
      await expect(ArtistModel.create({ name, source: 'upload' })).rejects.toThrow();
    }

    // Artists only — a podcast person credited as "Unknown" is a different claim
    // about a different kind of row.
    await PersonModel.create({ name: 'Unknown' });
    expect(await PersonModel.countDocuments({})).toBe(1);

    // Vacuity floor: a validator that rejected everything would pass the above.
    await ArtistModel.create({ name: 'Unknown Mortal Orchestra', source: 'upload' });
    expect(await ArtistModel.countDocuments({})).toBe(1);
  });

  it('artist nameKey uniqueness is ARTIST-scoped, not collection-wide', async () => {
    await ArtistModel.create({ name: 'Jane Smith', source: 'upload' });

    // Persons share this collection and dedup by strong keys — two podcast guests
    // genuinely called "Jane Smith" are two persons. A collection-wide unique
    // index on nameKey would make them collide with each other and with the
    // unrelated artist above.
    await PersonModel.create({ name: 'Jane Smith' });
    await PersonModel.create({ name: 'Jane Smith', href: 'https://x/js2' });

    expect(await PersonModel.countDocuments({ nameKey: 'jane smith' })).toBe(2);
    expect(await ArtistModel.countDocuments({ nameKey: 'jane smith' })).toBe(1);
  });

  it('legacy rows with no nameKey at all are not constrained by it', async () => {
    // Written through the driver, bypassing the schema hook, because that is the
    // only way to produce the shape this guards: documents that predate the
    // field. The partial filter is `nameKey: {$type:'string'}`, so they stay OUT
    // of the index instead of all colliding on one missing-value slot.
    await CatalogEntityModel.collection.insertMany([
      { type: 'artist', name: 'Legacy One', source: 'upload' },
      { type: 'artist', name: 'Legacy Two', source: 'upload' },
    ]);

    expect(await ArtistModel.countDocuments({})).toBe(2);
  });

  it('artists dedup by musicbrainzArtistId (sparse-unique)', async () => {
    await ArtistModel.create({
      name: 'MB Artist',
      source: 'upload',
      externalIds: { musicbrainzArtistId: 'mbid-1' },
    });

    await expect(
      ArtistModel.create({
        name: 'MB Artist Renamed',
        source: 'upload',
        externalIds: { musicbrainzArtistId: 'mbid-1' },
      }),
    ).rejects.toThrow();
  });

  it('a new artist defaults to origin:registered and acceptsContributions:false', async () => {
    const artist = await ArtistModel.create({ name: 'Default Fields', source: 'upload' });

    expect(artist.origin).toBe('registered');
    // Contributions to a claimed artist stay blocked until the artist opts in.
    expect(artist.acceptsContributions).toBe(false);
  });
});

describe('artist photo suggestions', () => {
  const commonsSuggestion = {
    image: {
      origin: 'external' as const,
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
      width: 1200,
      height: 1600,
      provider: 'wikimedia-commons' as const,
      licence: {
        licence: 'CC-BY-SA-4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'Jane Photographer',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
      },
    },
    proposedAt: new Date(),
  };

  it('is NOT returned by an ordinary artist query', async () => {
    const artist = await ArtistModel.create({
      name: 'Suggested Artist',
      source: 'upload',
      imageSuggestions: [commonsSuggestion],
    });

    // A suggestion is a GUESS about what somebody looks like. `select: false`
    // makes withholding it structural: a profile serializer cannot spread a
    // field the query never fetched, and `artistSchema` has no name for it
    // either, so it cannot be emitted deliberately.
    const found = await ArtistModel.findById(artist._id).lean();
    expect(found?.imageSuggestions).toBeUndefined();

    const listed = await ArtistModel.find({ name: 'Suggested Artist' }).lean();
    expect(listed[0]?.imageSuggestions).toBeUndefined();
  });

  it('IS stored, and readable by the claim flow when asked for explicitly', async () => {
    // Vacuity floor for the test above: if it were never persisted, "not
    // returned" would pass for the wrong reason.
    const artist = await ArtistModel.create({
      name: 'Suggested Artist',
      source: 'upload',
      imageSuggestions: [commonsSuggestion],
    });

    const withSuggestions = await ArtistModel.findById(artist._id)
      .select('+imageSuggestions')
      .lean();
    expect(withSuggestions?.imageSuggestions).toHaveLength(1);

    // Narrowing on `origin` rather than reaching for `.licence` directly is the
    // union doing its job: the licence is not even addressable on the arm that
    // has no third party to credit.
    const image = withSuggestions?.imageSuggestions?.[0]?.image;
    expect(image?.origin).toBe('external');
    if (image?.origin === 'external') {
      expect(image.licence.attribution).toBe('Jane Photographer');
      expect(image.licence.sourceUrl).toBe('https://commons.wikimedia.org/wiki/File:Artist.jpg');
    }
  });

  it('refuses an external suggestion with no licence', async () => {
    // "We will add the licence later" must not be storable — an unattributed
    // CC BY-SA image is a licence breach, not an untidy record.
    await expect(
      ArtistModel.create({
        name: 'Unlicensed Suggestion',
        source: 'upload',
        imageSuggestions: [{
          image: {
            origin: 'external',
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
            provider: 'wikimedia-commons',
          },
          proposedAt: new Date(),
        }],
      }),
    ).rejects.toThrow();
  });

  it('allows an own-upload suggestion with no licence', async () => {
    // A picture embedded in the uploader's own file arrives with the same
    // provenance as the audio they attested to — there is no third party to
    // credit, so requiring one would block the common case.
    const artist = await ArtistModel.create({
      name: 'Embedded Art Artist',
      source: 'upload',
      imageSuggestions: [{
        image: { origin: 'upload', url: '/api/images/507f1f77bcf86cd799439011' },
        proposedAt: new Date(),
        sourceUploadId: 'upload-1',
      }],
    });

    const stored = await ArtistModel.findById(artist._id).select('+imageSuggestions').lean();
    expect(stored?.imageSuggestions).toHaveLength(1);
    expect(stored?.imageSuggestions?.[0]?.image.origin).toBe('upload');
  });
});
