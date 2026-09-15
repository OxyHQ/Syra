import { parsePlaylistMetadata } from '../utils/playlist-metadata';

describe('metadata-only playlist import', () => {
  it('reads exported CSV headers with quoting, embedded newlines and escaped quotes', () => {
    const rows = parsePlaylistMetadata('\uFEFFTrack Name,Artist Name(s),ISRC\r\n"Song, Part 1","An ""artist""",USABC2600001\r\n"Two\nlines",Other,');
    expect(rows).toEqual([
      { title: 'Song, Part 1', artist: 'An "artist"', isrc: 'USABC2600001' },
      { title: 'Two\nlines', artist: 'Other' },
    ]);
  });
  it('accepts JSON arrays and export envelopes without importing provider ids or URLs', () => {
    const rows = parsePlaylistMetadata(JSON.stringify({ tracks: [{ title: 'Song', artist: 'Artist', id: 'external-provider-id', url: 'https://example.test/private.mp3' }] }));
    expect(rows).toEqual([{ title: 'Song', artist: 'Artist' }]);
    expect(parsePlaylistMetadata('[{"catalogId":"syra-id"}]')).toEqual([{ catalogId: 'syra-id' }]);
  });
  it('does not accept ambiguous malformed records, duplicate headers or missing identities', () => {
    for (const input of ['title,artist\n"unfinished,Artist', 'title,title\nOne,Two', '[{"url":"https://example.test"}]', '{bad', 'title,artist\nSong,Artist,extra']) {
      expect(() => parsePlaylistMetadata(input)).toThrow();
    }
  });
  it('rejects oversized files and too many rows rather than silently truncating', () => {
    expect(() => parsePlaylistMetadata('a'.repeat(1024 * 1024 + 1))).toThrow('tools.importLimit');
    expect(() => parsePlaylistMetadata(JSON.stringify(Array.from({ length: 501 }, () => ({ title: 'Song', artist: 'Artist' }))))).toThrow('tools.importLimit');
  });
});
