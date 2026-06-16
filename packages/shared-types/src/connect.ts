/**
 * Syra Connect — multi-device playback types.
 *
 * Used by both the backend device registry / playback-state service and the
 * frontend Connect UI (device list, transfer, remote control).
 */

import { RepeatMode } from './player';
import { CatalogSource } from './track';

/** Physical or virtual form-factor of a connected playback device. */
export type DeviceType = 'web' | 'mobile' | 'desktop' | 'speaker';

/** A registered playback device belonging to an Oxy user. */
export interface Device {
  id?: string;
  deviceId: string;       // client-generated stable identifier
  name: string;
  type: DeviceType;
  capabilities: string[]; // e.g. ['play', 'volume', 'seek']
  lastSeen: string;       // ISO 8601
  isActive: boolean;
}

/** Commands that can be issued to the active device via the Connect socket. */
export type PlaybackCommandType =
  | 'play'
  | 'pause'
  | 'seek'
  | 'next'
  | 'prev'
  | 'transfer'
  | 'volume'
  | 'shuffle'
  | 'repeat';

export interface PlaybackCommand {
  type: PlaybackCommandType;
  positionMs?: number;
  volume?: number;    // 0-1
  shuffle?: boolean;
  repeat?: RepeatMode;
  deviceId?: string; // target device for 'transfer'
}

/** Server-authoritative playback state stored per user (Phase 6.2+). */
export interface ConnectPlaybackState {
  trackId?: string;
  source?: CatalogSource;
  positionMs: number;
  isPlaying: boolean;
  queue: string[];         // ordered trackIds (no full Track objects)
  contextType?: string;
  contextId?: string;
  repeat: RepeatMode;
  shuffle: boolean;
  volume: number;          // 0-1
  activeDeviceId?: string;
  updatedAt: string;       // ISO 8601
}
