import type React from 'react';
import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '@oxy.so/services';
import { useAuthGate } from '@/hooks/useAuthGate';
import { usePlayerStore } from '@/stores/playerStore';

const AskAliaSheet = lazy(() => import('./AskAliaSheet'));

/**
 * The "Ask Alia" entry point: a sparkle button for the top bar and the chat
 * sheet it opens.
 *
 * The sheet is mounted only with a usable session — Alia's calls are private —
 * and a signed-out press opens the Oxy sign-in dialog instead. What the person
 * is listening to rides along in `clientContext`, so "who is this?" needs no
 * explanation.
 *
 * The sheet (and the Alia SDK behind it) loads on the first press, not with the
 * entry bundle.
 */
export const AskAlia: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { openAccountDialog } = useOxy();
  const { canUsePrivateApi } = useAuthGate();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const [presentSignal, setPresentSignal] = useState(0);

  const clientContext = useMemo(() => {
    const base = t('topbar.aliaClientContext');
    if (!currentTrack) return base;
    return `${base} ${t('topbar.aliaNowPlaying', {
      title: currentTrack.title,
      artist: currentTrack.artistName,
    })}`;
  }, [t, currentTrack]);

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'discover', text: t('topbar.aliaSuggestion.discover') },
      { id: 'playlist', text: t('topbar.aliaSuggestion.playlist') },
      { id: 'similar', text: t('topbar.aliaSuggestion.similar') },
    ],
    [t],
  );

  const handlePress = useCallback(() => {
    if (!canUsePrivateApi) {
      openAccountDialog('signin');
      return;
    }
    setPresentSignal((signal) => signal + 1);
  }, [canUsePrivateApi, openAccountDialog]);

  return (
    <>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t('topbar.askAlia')}
        className="h-10 w-10 items-center justify-center rounded-full"
      >
        <AliaAvatarIcon width={24} height={24} fill={theme.colors.text} />
      </Pressable>
      {canUsePrivateApi && presentSignal > 0 && (
        <Suspense fallback={null}>
          <AskAliaSheet
            presentSignal={presentSignal}
            clientContext={clientContext}
            welcomeSuggestions={welcomeSuggestions}
          />
        </Suspense>
      )}
    </>
  );
};
