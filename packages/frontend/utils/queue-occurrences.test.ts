import type { Queue, PlayableItem } from '@syra/shared-types';
import { moveQueueOccurrence, removeQueueOccurrence } from './queue-occurrences';
const item = (id: string): PlayableItem => ({ kind: 'track', id, title: id, artistId: 'artist', artistName: 'Artist', duration: 100, isExplicit: false, isAvailable: true, source: 'upload', status: 'ready', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
describe('queue occurrences', () => {
  it('moves the selected duplicate without jumping to the first occurrence', () => {
    const queue: Queue = { current: 2, tracks: [item('same'), item('other'), item('same')] };
    const moved = moveQueueOccurrence(queue, 2, 0);
    expect(moved.current).toBe(0);
    expect(moved.tracks[0]).toBe(queue.tracks[2]);
    expect(queue.current).toBe(2);
  });
  it('tracks the active occurrence when another item crosses it', () => {
    const queue: Queue = { current: 1, tracks: [item('a'), item('b'), item('c')] };
    expect(moveQueueOccurrence(queue, 0, 2).current).toBe(0);
    expect(moveQueueOccurrence(queue, 2, 0).current).toBe(2);
  });
  it('removes one duplicate only and refuses removal of the playing occurrence', () => {
    const queue: Queue = { current: 1, tracks: [item('same'), item('same'), item('c')] };
    expect(removeQueueOccurrence(queue, 1)).toBe(queue);
    const removed = removeQueueOccurrence(queue, 0);
    expect(removed.current).toBe(0);
    expect(removed.tracks[0]).toBe(queue.tracks[1]);
    expect(removed.tracks).toHaveLength(2);
  });
  it('rejects invalid and fractional positions', () => {
    const queue: Queue = { current: 0, tracks: [item('a')] };
    expect(moveQueueOccurrence(queue, -1, 0)).toBe(queue);
    expect(removeQueueOccurrence(queue, 0.5)).toBe(queue);
  });
});
