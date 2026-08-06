/**
 * Syra's chain lexicons.
 *
 * The case that carries the weight is `unlisted`. Everything else here is schema
 * shape; that one is a disclosure boundary, and it is the one a reasonable
 * person writes as `!== 'private'` without noticing they just published every
 * unlisted playlist in the product.
 */

import { describe, expect, it } from 'bun:test';
import { PlaylistVisibility } from '../playlist';
import {
  SYRA_FEED_COLLECTIONS,
  SYRA_PLAYLIST_COLLECTION,
  SYRA_PLAYLIST_INLINE_TRACK_CAP,
  SYRA_TOMBSTONE_COLLECTION,
  isChainPublishablePlaylist,
  syraPlaylistRecordSchema,
  syraRecordSubject,
  syraTombstoneRecordSchema,
} from './lexicons';

describe('isChainPublishablePlaylist', () => {
  it('publishes a public playlist', () => {
    expect(isChainPublishablePlaylist(PlaylistVisibility.PUBLIC)).toBe(true);
  });

  it('refuses a private one', () => {
    expect(isChainPublishablePlaylist(PlaylistVisibility.PRIVATE)).toBe(false);
  });

  it('refuses an UNLISTED one', () => {
    // The fixture that tells `=== 'public'` from `!== 'private'`. An unlisted
    // playlist is reachable by link and absent from every listing; putting it on
    // a chain other apps read would un-list it, which is the one thing its owner
    // asked for. Without this case both implementations pass.
    expect(isChainPublishablePlaylist(PlaylistVisibility.UNLISTED)).toBe(false);
  });

  it('covers every visibility the product defines', () => {
    // A vacuity floor: if a fourth visibility is added, this fails until someone
    // decides which side of the boundary it belongs on.
    expect(Object.values(PlaylistVisibility).sort()).toEqual(['private', 'public', 'unlisted']);
  });
});

describe('collections', () => {
  it('names both collections under the app.syra. namespace', () => {
    // The prefix is what oxy-api's namespace grant matches on, so a collection
    // outside it would be refused at write time with a 403 nobody expects.
    for (const nsid of SYRA_FEED_COLLECTIONS) {
      expect(nsid.startsWith('app.syra.')).toBe(true);
    }
    expect(SYRA_FEED_COLLECTIONS).toEqual([SYRA_PLAYLIST_COLLECTION, SYRA_TOMBSTONE_COLLECTION]);
  });
});

describe('syraPlaylistRecordSchema', () => {
  const valid = {
    playlistId: 'pl_1',
    name: 'Domingo',
    trackCount: 2,
    tracks: [{ trackId: 't1', title: 'One' }],
    createdAt: '2026-08-06T00:00:00.000Z',
  };

  it('accepts a minimal record', () => {
    expect(syraPlaylistRecordSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a trackCount larger than the inline tracks', () => {
    // Deliberate: the record carries what a reader needs to render, not the
    // playlist's whole state.
    expect(syraPlaylistRecordSchema.safeParse({ ...valid, trackCount: 900 }).success).toBe(true);
  });

  it('refuses more inline tracks than the cap', () => {
    const tracks = Array.from({ length: SYRA_PLAYLIST_INLINE_TRACK_CAP + 1 }, (_, i) => ({
      trackId: `t${i}`,
      title: `Track ${i}`,
    }));
    expect(syraPlaylistRecordSchema.safeParse({ ...valid, tracks }).success).toBe(false);
  });

  it('refuses an empty name and a negative count', () => {
    expect(syraPlaylistRecordSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
    expect(syraPlaylistRecordSchema.safeParse({ ...valid, trackCount: -1 }).success).toBe(false);
  });
});

describe('tombstones', () => {
  it('names the record it supersedes by collection and key', () => {
    expect(syraRecordSubject(SYRA_PLAYLIST_COLLECTION, 'pl_1')).toBe('app.syra.feed.playlist/pl_1');
  });

  it('accepts a well-formed tombstone', () => {
    expect(
      syraTombstoneRecordSchema.safeParse({
        subject: syraRecordSubject(SYRA_PLAYLIST_COLLECTION, 'pl_1'),
        createdAt: '2026-08-06T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
