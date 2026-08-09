# Multi-artist uploads: real entities, linked by id

## The report

A file tagged `benny blanco, Bb trickz` produced ONE artist with that comma in
its name (`/p/019fe4af-59ee-7b80-be0e-57e61edea32e`). Two artists, one row.

## Why it happens, and why the obvious fix is wrong

`splitArtistCredit` deliberately refuses to split on a bare comma. Its own
comment says why: `Earth, Wind & Fire` becomes `Earth` with two invented
featured artists, and `Crosby, Stills & Nash` and every `… & The …` band go the
same way. Comma-splitting does not create a wrong LINK — it publishes wrong
CREDITS, which is a visible, permanent lie about who played on a record.

So the fix cannot be "split on comma". It has to be a better signal.

## The premise that changed

`track_credits` has no `catalog_entity_id` column, and the schema explains that
as: four Mongoose paths declared it, none ever wrote it, because a name from an
enrichment source "is not a high-confidence identity claim".

That reasoning is sound and it is about ENRICHMENT names. It does not cover the
signal this design uses. When an upload's ISRC resolves, or its acoustic
fingerprint matches, the registry returns artists already separated and carrying
a MusicBrainz id. That IS a high-confidence identity claim — the first one this
column would ever have had. The requirement (real entities, linked by id) and the
earlier decision do not conflict; the second unblocks the first.

## Resolution precedence

Explicit, ordered, no heuristics:

1. **Registry resolved** (ISRC or acoustic fingerprint → MusicBrainz).
   Artists arrive separated and identified. Create or reuse a `catalog_entities`
   row per artist and link **by id**. High confidence.
2. **File multi-value tags** (`ExtractedMetadata.artists`, already surfaced by
   the extractor as every artist string the file declares). One entity per name,
   no external id. Medium confidence.
3. **A single string, comma or not, with no external signal.** Kept whole,
   exactly as today. `Earth, Wind & Fire` survives.

A comma is never itself a reason to split.

## Schema

`track_credits` gains `catalog_entity_id text references catalog_entities(id)`,
NULLABLE and `on delete set null`:

- **Nullable** because precedence 2 and 3 produce a credit with a name and no
  identity, and inventing one would be exactly the lie the original decision
  refused.
- **`set null`, not `cascade`** because deleting an artist entity must not delete
  the credit — the person was still on the record; only our claim about which
  catalogue row they are goes away.

Additive, so it ships `--phase=pre`.

## Repair

Entities already created wrong (a comma-joined name with tracks attached) are
not fixable by re-uploading — the audio is in S3 and the rows are live. A script
takes such an entity, resolves its parts through the same precedence, creates the
real entities, re-points the track's `artistId` at the principal, writes the
featured ones into `track_credits`, and deletes the merged row once nothing
references it.

It runs one entity at a time by id, not as a sweep: this is a repair for known
damage, not a migration, and a sweep over a catalogue of legitimate comma names
is the comma-splitting mistake in a different costume.

## Verification

- `splitArtistCredit`'s guard cases stay green (`Earth, Wind & Fire`,
  `Crosby, Stills & Nash`, `Sunn O)))`).
- A registry-resolved upload writes N entities and N−1 credits with ids.
- A tag-only upload writes entities with `catalog_entity_id` NULL.
- A comma name with no signal stays one entity — the case that must NOT change.
- The repair, run twice, is idempotent.
