import type { Episode } from '@syra/shared-types';

/**
 * Whether an episode's media may need the caller's identity attached, and must
 * therefore be resolved through `GET /podcasts/episodes/:id/stream` rather than
 * played from the unauthenticated `/audio` URL.
 *
 * **Not "does it have an HLS ladder".** That was the old test, and it is what
 * made a private show unplayable by its own owner: a private episode never has
 * a ladder — `ingestEpisode` skips the transcode on purpose, so no unrevocable
 * presigned segment URLs exist — so the old test said no for exactly the
 * episodes whose media requires a caller, they fell through to the public URL,
 * that URL answered 404, and the browser reported `NotSupportedError: Failed to
 * load because no supported source was found`.
 *
 * External (rss) episodes and signed-out listeners keep the plain proxy: it is
 * the enclosure every podcast client fetches from the RSS feed, and for them it
 * is genuinely public.
 *
 * A module-level function taking the session as an argument, rather than a
 * closure reading it: this is the decision the bug lived in, so it has to be
 * reachable by a test without booting a playback engine.
 */
export function episodeNeedsResolvedSource(episode: Episode, hasSession: boolean): boolean {
  return episode.source === 'syra' && episode.status === 'ready' && hasSession;
}
