import type { Queue } from '@syra/shared-types';

/** Position, not track id, identifies an occurrence of a repeated song. */
export function moveQueueOccurrence(queue: Queue, from: number, to: number): Queue {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= queue.tracks.length || to >= queue.tracks.length || from === to) return queue;
  const tracks = [...queue.tracks];
  const [item] = tracks.splice(from, 1);
  if (!item) return queue;
  tracks.splice(to, 0, item);
  let current = queue.current;
  if (current === from) current = to;
  else if (from < current && to >= current) current -= 1;
  else if (from > current && to <= current) current += 1;
  return { ...queue, tracks, current };
}

/** The active occurrence stays until playback advances or the listener stops. */
export function removeQueueOccurrence(queue: Queue, index: number): Queue {
  if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.length || index === queue.current) return queue;
  return { ...queue, tracks: queue.tracks.filter((_, position) => position !== index), current: index < queue.current ? queue.current - 1 : queue.current };
}
