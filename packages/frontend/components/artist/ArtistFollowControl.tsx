/**
 * The follow control on an artist profile.
 *
 * The authority for "does this listener follow this artist" is the Oxy follow
 * graph, not Syra: `FollowTargetButton` reads and writes the one relationship
 * the whole ecosystem shares (see `lib/followGraph.ts`). Syra's own
 * `Library.followedArtists` stays what it has always been — the "Artists" shelf
 * in Your Library and an input to the taste profile — and is kept in step from
 * here, so there is ONE control the listener presses rather than two mechanisms
 * that can disagree.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxyhq/bloom/button';
import { FollowTargetButton, useOxy } from '@oxyhq/services';
import { useAuthGate } from '@/hooks/useAuthGate';
import { useToggleFollowArtist } from '@/hooks/useLibrary';
import { ARTIST_FOLLOW_KIND, ensureArtistFollowTarget } from '@/lib/followGraph';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('ArtistFollowControl');

export interface ArtistFollowControlProps {
  artistId: string;
  /** Display name for the shared target snapshot other applications render. */
  artistName: string;
  size?: 'small' | 'medium' | 'large';
  /**
   * Show the disclosure chevron. Off in the sticky header, where the row is a
   * strip of icon-sized controls and a second target is more likely to be hit by
   * accident than used on purpose.
   */
  showOptions?: boolean;
}

export const ArtistFollowControl = memo(function ArtistFollowControl({
  artistId,
  artistName,
  size = 'medium',
  showOptions = true,
}: ArtistFollowControlProps) {
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { openAccountDialog } = useOxy();
  const { mutate: mirrorToLibrary } = useToggleFollowArtist();

  const labels = useMemo(
    () => ({
      idle: t('artist.followLabels.idle'),
      active: t('artist.followLabels.active'),
      pending: t('artist.followLabels.pending'),
      disabled: t('artist.followLabels.disabled'),
    }),
    [t],
  );

  // Registering a target is user-delegated, so it waits for a usable session
  // rather than for `isAuthenticated` — during a cold boot the second is true
  // well before the first, and a registration sent in that window 401s.
  //
  // A target id never changes once registered, hence `staleTime: Infinity`. The
  // key is the artist alone: the name rides along as a display snapshot, and
  // refreshing that snapshot is not what this query is for.
  const targetQuery = useQuery({
    queryKey: ['follow-target', ARTIST_FOLLOW_KIND, artistId],
    queryFn: () =>
      ensureArtistFollowTarget({ artistId, name: artistName }).catch((error: unknown) => {
        logger.error('Could not resolve the artist follow target', { error, artistId });
        throw error;
      }),
    enabled: gate.canUsePrivateApi && Boolean(artistId),
    staleTime: Infinity,
  });

  /**
   * Keep Syra's own shelf in step with the press.
   *
   * `onChange` fires only for a write the server accepted (`@oxyhq/services`
   * >= 27.1.1), so this is a plain mirror with nothing to reconcile.
   */
  const handleChange = useCallback(
    (following: boolean) => {
      mirrorToLibrary({ id: artistId, next: following });
    },
    [artistId, mirrorToLibrary],
  );

  const targetId = targetQuery.data;

  if (gate.canUsePrivateApi && targetId) {
    return (
      <FollowTargetButton
        targetId={targetId}
        verb="follow"
        labels={labels}
        size={size}
        showOptions={showOptions}
        // An artist is not an event or a trial, so a follow that lapses on its
        // own would quietly empty part of someone's library. The disclosure
        // carries only "don't show in Syra" and "unfollow everywhere".
        durations={false}
        applicationName="Syra"
        onChange={handleChange}
      />
    );
  }

  // Signed out: the same affordance every other library action offers — press it
  // and the SDK's in-app sign-in opens. Otherwise — session still resolving, or
  // signed in with no target yet because registration is in flight or failed —
  // the button is inert rather than inviting a follow nothing could record. A
  // failed registration therefore shows an unpressable button and a logged
  // error, which is the honest shape: without a target there is nothing to
  // follow, and offering the press would only lose it.
  return (
    <Button
      variant="primary"
      size={size}
      disabled={!gate.isResolved || gate.canUsePrivateApi}
      onPress={() => openAccountDialog('signin')}
      accessibilityLabel={labels.idle}
    >
      {labels.idle}
    </Button>
  );
});
