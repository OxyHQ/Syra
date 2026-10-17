/**
 * Playing a row from its Oxy audio file (OxyHQ/oxy ADR 0043 stage 4c) — what
 * every stream resolver (a catalogue track, a locker upload, an episode) asks
 * before it falls back to its legacy ladder.
 *
 * A play is one Oxy play session for the listener: AES-128, the key released
 * only after Syra's file-events endpoint allows it (`audioKeyAuthorization.ts`
 * makes the same entitlement decision the legacy key endpoints do). The player
 * gets Oxy's URLs; Syra never proxies a segment.
 *
 * ## The bitrate cap
 *
 * Oxy's ladder has three rungs (AAC 64/128/256 kbps, a rung above the source's
 * own bitrate skipped). A listener's cap (`computeMaxBitrateKbps`: 96 with data
 * saver, 160 free, 320 premium) opens the session with only the rungs at or
 * under it ({@link renditionsUnderCap}), and Oxy enforces that list on every
 * request of the session: its master lists only those rungs, and any other
 * rung's playlist, segments and key answer 404, each allowed rung under its own
 * key. A client that rewrites a rendition URL reaches nothing. Entitlement
 * itself — whether this listener may play the file — is the key's, per play.
 */

import type { PlaySessionRendition } from '@oxy.so/core';
import { openPlaySession, oxyAudioEnabled } from '../oxyFiles/audioStorage';

export type OxyPlaybackDecision =
  /** Play from Oxy: the response the resolver answers with. */
  | { kind: 'oxy'; stream: OxyStreamResponse }
  /** The row has no Oxy file, or Oxy cannot serve it now: the legacy ladder plays. */
  | { kind: 'legacy'; ladderPending: boolean }
  /** Oxy reported the file withdrawn (trashed, deleted, taken down): nothing plays it. */
  | { kind: 'withdrawn' };

/** What `GET …/stream` answers when the play comes from Oxy. */
export interface OxyStreamResponse {
  url: string;
  type: 'hls';
  expiresAt: string;
  /** The 30-second preview clip, through the same session. */
  previewUrl?: string;
  /** The waveform peaks (audiowaveform JSON), through the same session. */
  waveformUrl?: string;
}

/** Oxy's audio ladder, lowest first: each rung and its bitrate. */
const AUDIO_LADDER: ReadonlyArray<readonly [PlaySessionRendition, number]> = [
  ['hls_a64', 64],
  ['hls_a128', 128],
  ['hls_a256', 256],
];

/**
 * The rungs a cap permits — the lowest one when none is under it, so a play
 * never comes back empty — or `undefined` when it permits the whole ladder
 * (the session is then opened without a list).
 */
export function renditionsUnderCap(maxBitrateKbps: number): PlaySessionRendition[] | undefined {
  const permitted = AUDIO_LADDER.filter(([, kbps]) => kbps <= maxBitrateKbps).map(
    ([rendition]) => rendition,
  );
  if (permitted.length === AUDIO_LADDER.length) return undefined;
  return permitted.length > 0 ? permitted : [AUDIO_LADDER[0][0]];
}

/**
 * Whether this row plays from Oxy, and if so the response to answer with.
 * Never throws: everything short of "withdrawn" leaves the legacy ladder to
 * play.
 */
export async function decideOxyPlayback(input: {
  audioFileId: string | null;
  endUserId: string;
  maxBitrateKbps: number;
  durationSec?: number | null;
}): Promise<OxyPlaybackDecision> {
  if (!input.audioFileId || !oxyAudioEnabled()) return { kind: 'legacy', ladderPending: false };
  const renditions = renditionsUnderCap(input.maxBitrateKbps);
  const result = await openPlaySession({
    fileId: input.audioFileId,
    endUserId: input.endUserId,
    durationSec: input.durationSec ?? null,
    ...(renditions ? { renditions } : {}),
  });
  if (result.ok) {
    return {
      kind: 'oxy',
      stream: {
        url: result.playback.masterUrl,
        type: 'hls',
        expiresAt: result.playback.expiresAt,
        ...(result.playback.previewUrl ? { previewUrl: result.playback.previewUrl } : {}),
        ...(result.playback.waveformUrl ? { waveformUrl: result.playback.waveformUrl } : {}),
      },
    };
  }
  if (result.reason === 'withdrawn') return { kind: 'withdrawn' };
  return { kind: 'legacy', ladderPending: result.reason === 'not_ready' };
}
