import { describe, expect, it } from 'bun:test';
import { parseRecordingListQuery } from './recordingsQuery';

describe('public recording list query', () => {
  it('defaults the sort and size and caps a valid limit', () => {
    expect(parseRecordingListQuery({})).toEqual({ sort: 'recent', limit: 10 });
    expect(parseRecordingListQuery({ sortBy: 'popular', limit: '25' })).toEqual({
      sort: 'popular',
      limit: 25,
    });
    expect(parseRecordingListQuery({ sortBy: 'other', limit: '200' })).toEqual({
      sort: 'recent',
      limit: 50,
    });
  });

  it('rejects malformed numeric formats and uses the first repeated limit', () => {
    for (const limit of ['0', '-5', '5abc', '0x10', '1e2', '', 'Infinity']) {
      expect(parseRecordingListQuery({ limit }).limit).toBe(10);
    }
    expect(parseRecordingListQuery({ limit: ['7', '50'] }).limit).toBe(7);
  });
});
