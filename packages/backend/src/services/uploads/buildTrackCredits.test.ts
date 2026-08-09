import { describe, expect, it } from 'bun:test';
import { normalizeNameKey } from '@syra/shared-types';
import { buildTrackCredits } from './buildTrackCredits';

/**
 * The fixtures here all sit on the side of a distinction the builder exists to
 * make. A single featured artist cannot tell "keeps the list" from "keeps the
 * first"; a credit set with no repeats cannot tell "de-duplicates" from "does
 * not"; and a person credited once cannot tell de-duplication BY NAME from
 * de-duplication by `(name, role)` — which is the whole point, because the same
 * person is often both a performer and the producer.
 */
describe('buildTrackCredits', () => {
  it('credits every featured artist and carries the id the match proved', () => {
    const rows = buildTrackCredits({
      featured: [
        { artist: { name: 'Bb trickz', mbid: 'mbid-bb' }, catalogEntityId: 'ent-bb' },
        { artist: { name: 'Otro', mbid: 'mbid-otro' }, catalogEntityId: 'ent-otro' },
      ],
      tagged: [],
    });

    expect(rows.map((row) => row.name)).toEqual(['Bb trickz', 'Otro']);
    expect(rows.map((row) => row.catalogEntityId)).toEqual(['ent-bb', 'ent-otro']);
    expect(rows.map((row) => row.role)).toEqual(['artist', 'artist']);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
  });

  it('leaves a tag credit WITHOUT an entity id, because a tag is not an identity', () => {
    const rows = buildTrackCredits({
      featured: [],
      tagged: [{ name: 'Ana Gil', role: 'producer' }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.catalogEntityId).toBeUndefined();
    expect(rows[0]?.role).toBe('producer');
  });

  it('keeps the SAME person under two different roles', () => {
    // The case that distinguishes de-duplication by `(name, role)` from
    // de-duplication by name: collapsing these deletes a real credit.
    const rows = buildTrackCredits({
      featured: [{ artist: { name: 'Ana Gil', mbid: 'm' }, catalogEntityId: 'ent-ana' }],
      tagged: [{ name: 'Ana Gil', role: 'producer' }],
    });

    expect(rows.map((row) => row.role)).toEqual(['artist', 'producer']);
  });

  it('drops a repeat of the same person in the same role', () => {
    const rows = buildTrackCredits({
      featured: [{ artist: { name: 'Ana Gil', mbid: 'm' }, catalogEntityId: 'ent-ana' }],
      tagged: [{ name: 'ana  gil', role: 'artist' }],
    });

    expect(rows).toHaveLength(1);
    // The identified entry wins — it is the one carrying a claim we can stand behind.
    expect(rows[0]?.catalogEntityId).toBe('ent-ana');
  });

  it('never credits the track’s own artist as a guest', () => {
    const rows = buildTrackCredits({
      featured: [
        { artist: { name: 'benny blanco', mbid: 'mbid-benny' }, catalogEntityId: 'ent-benny' },
        { artist: { name: 'Bb trickz', mbid: 'mbid-bb' }, catalogEntityId: 'ent-bb' },
      ],
      tagged: [],
      principalNameKey: normalizeNameKey('benny blanco'),
    });

    expect(rows.map((row) => row.name)).toEqual(['Bb trickz']);
    // Positions are compacted, not left with a hole where the principal was.
    expect(rows[0]?.position).toBe(0);
  });

  it('ignores blank and unkeyable names rather than writing empty credits', () => {
    const rows = buildTrackCredits({
      featured: [],
      tagged: [
        { name: '   ', role: 'producer' },
        { name: '', role: 'mixer' },
      ],
    });

    expect(rows).toEqual([]);
  });
});
