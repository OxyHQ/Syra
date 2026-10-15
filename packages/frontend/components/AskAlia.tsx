import React, { useCallback, useMemo, useRef } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { VoiceSession } from '@alia.onl/sdk/voice';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '@oxy.so/services';
import { useAuthGate } from '@/hooks/useAuthGate';
import { usePlayerStore } from '@/stores/playerStore';

/**
 * The "Ask Alia" entry point: a sparkle button for the top bar and the chat
 * sheet it opens.
 *
 * The sheet is mounted only with a usable session — Alia's calls are private —
 * and a signed-out press opens the Oxy sign-in dialog instead. What the person
 * is listening to rides along in `clientContext`, so "who is this?" needs no
 * explanation.
 */
export const AskAlia: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { openAccountDialog } = useOxy();
  const { canUsePrivateApi } = useAuthGate();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const aliaChatRef = useRef<AliaChatSheetRef>(null);

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
    aliaChatRef.current?.present();
  }, [canUsePrivateApi, openAccountDialog]);

  return (
    <>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t('topbar.askAlia')}
        className="h-10 w-10 items-center justify-center rounded-full"
      >
        <RiSparklingLine width={24} height={24} fill={theme.colors.text} />
      </Pressable>
      {canUsePrivateApi && (
        <AliaChatSheet
          ref={aliaChatRef}
          voiceSession={VoiceSession}
          clientContext={clientContext}
          welcomeSuggestions={welcomeSuggestions}
        />
      )}
    </>
  );
};
