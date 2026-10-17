import { describe, expect, it } from 'bun:test';
import { getTrackS3Key } from './audioStorageService';

/**
 * The original is where it was WRITTEN. The key derived from the row is right
 * only while the track keeps the artist and album it was uploaded under.
 */
describe('getTrackS3Key', () => {
  const track = {
    id: 't-1',
    artistId: 'ce-new',
    albumId: 'al-2',
    title: 'T',
    audioSource: { url: '/api/audio/t-1', format: 'mp3' as const },
  };

  it('answers the key recorded at upload, even after the artist and album moved', () => {
    expect(getTrackS3Key({ ...track, audioSourceKey: 'audio/ce-old/al-1/t-1.mp3' })).toBe(
      'audio/ce-old/al-1/t-1.mp3',
    );
  });

  it('derives the key only for a row that has none recorded', () => {
    expect(getTrackS3Key({ ...track, audioSourceKey: null })).toBe('audio/ce-new/al-2/t-1.mp3');
    expect(getTrackS3Key(track)).toBe('audio/ce-new/al-2/t-1.mp3');
  });
});
