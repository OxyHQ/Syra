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
 * saver, 160 free, 320 premium) keeps the rungs at or under it: when that is
 * every rung the player opens Oxy's own master playlist, otherwise a master
 * Syra writes listing only the permitted rungs
 * (`GET /api/stream/oxy/master.m3u8?m=<signed list>`, {@link buildOxyMasterPlaylist}).
 * The cap is what the PLAYER is handed: a session's URLs are capabilities over
 * the whole ladder, and Oxy has no per-rendition grant, so a client that
 * rewrote a rendition URL could reach a higher rung of a file it is entitled to
 * play at all. Entitlement itself — whether this listener may play the file —
 * is enforced by the key, per play.
 */

import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { openPlaySession, oxyAudioEnabled, type OxyPlayback } from '../oxyFiles/audioStorage';
import { HLS_AUDIO_CODEC } from './manifestService';

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

/** A rung's bitrate from its rendition type (`hls_a128` → 128), or `null`. */
export function rungKbps(rendition: { type: string; bandwidth: number | null }): number | null {
  const match = /^hls_a(\d+)$/.exec(rendition.type);
  if (match) return Number(match[1]);
  return rendition.bandwidth ? Math.round(rendition.bandwidth / 1000) : null;
}

/** The rungs a cap permits; the lowest one when none is under it, so a play never comes back empty. */
export function permittedRenditions(
  renditions: OxyPlayback['renditions'],
  maxBitrateKbps: number,
): OxyPlayback['renditions'] {
  const rated = renditions
    .map((rendition) => ({ rendition, kbps: rungKbps(rendition) }))
    .filter(
      (entry): entry is { rendition: OxyPlayback['renditions'][number]; kbps: number } =>
        entry.kbps !== null,
    )
    .sort((a, b) => a.kbps - b.kbps);
  const permitted = rated.filter((entry) => entry.kbps <= maxBitrateKbps);
  if (permitted.length > 0) return permitted.map((entry) => entry.rendition);
  return rated.length > 0 ? [rated[0].rendition] : [];
}

interface OxyMasterClaims {
  r: Array<{ u: string; b: number }>;
}

function masterSecret(): string {
  const secret = process.env.STREAM_TOKEN_SECRET;
  if (!secret) throw new Error('STREAM_TOKEN_SECRET not set');
  return secret;
}

/** The player URL for a play session under a cap: Oxy's master, or Syra's capped one. */
export function playerUrlFor(playback: OxyPlayback, maxBitrateKbps: number): string {
  const permitted = permittedRenditions(playback.renditions, maxBitrateKbps);
  if (permitted.length === 0 || permitted.length === playback.renditions.length) {
    return playback.masterUrl;
  }
  const expiresInSec = Math.max(
    60,
    Math.floor((new Date(playback.expiresAt).getTime() - Date.now()) / 1000),
  );
  const claims: OxyMasterClaims = {
    r: permitted.map((rendition) => ({
      u: rendition.url,
      b: rendition.bandwidth ?? (rungKbps(rendition) ?? 0) * 1000,
    })),
  };
  const token = jwt.sign(claims, masterSecret(), { expiresIn: expiresInSec });
  return `${env.STREAM_KEY_BASE_URL}/api/stream/oxy/master.m3u8?m=${token}`;
}

/**
 * The capped master playlist a {@link playerUrlFor} URL names, or `null` for a
 * token that is not one (forged, expired, malformed).
 */
export function buildOxyMasterPlaylist(token: string): string | null {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, masterSecret());
  } catch {
    return null;
  }
  const renditions = (decoded as Partial<OxyMasterClaims> | null)?.r;
  if (!Array.isArray(renditions) || renditions.length === 0) return null;
  const lines = ['#EXTM3U'];
  for (const rendition of renditions) {
    if (
      typeof rendition?.u !== 'string' ||
      !rendition.u.startsWith('https://') ||
      typeof rendition.b !== 'number'
    ) {
      return null;
    }
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.b},CODECS="${HLS_AUDIO_CODEC}"`);
    lines.push(rendition.u);
  }
  return lines.join('\n');
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
  const result = await openPlaySession({
    fileId: input.audioFileId,
    endUserId: input.endUserId,
    durationSec: input.durationSec ?? null,
  });
  if (result.ok) {
    return {
      kind: 'oxy',
      stream: {
        url: playerUrlFor(result.playback, input.maxBitrateKbps),
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
