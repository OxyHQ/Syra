export interface ListeningSample {
  position: number;
  at: number;
  playing: boolean;
}

/** Count advancing audio, not the seek position. Paused/buffered time is zero. */
export function listenedBetween(previous: ListeningSample | null, next: ListeningSample): number {
  if (!previous || !previous.playing) return 0;
  const elapsed = (next.at - previous.at) / 1000;
  const advanced = next.position - previous.position;
  if (!Number.isFinite(elapsed) || !Number.isFinite(advanced) || elapsed <= 0 || advanced <= 0) return 0;
  // Tolerate scheduling jitter but not scrubbing forward. Music always plays at 1x.
  if (advanced > elapsed * 1.5 + 0.25) return 0;
  return Math.min(advanced, elapsed);
}
