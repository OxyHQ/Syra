import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AliaAskProvider, useAskAgent } from '@alia.onl/sdk/ask';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '@oxy.so/services/ui/client';
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
 *
 * The sheet (and the Alia chat behind it) loads on the first press, not with
 * the entry bundle: everything here comes from the SDK's `ask` and `avatar`
 * leaf entries. Importing the root `@alia.onl/sdk` entry anywhere — even behind
 * a lazy import — puts a second lazy chunk around the same chat, and Metro then
 * hoists the chat into the initial `__common` script.
 */
export const AskAlia: React.FC = () => {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((state) => state.currentTrack);

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

  return (
    <AliaAskProvider clientContext={clientContext} welcomeSuggestions={welcomeSuggestions}>
      <AskAliaButton />
    </AliaAskProvider>
  );
};

const AskAliaButton: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { openAccountDialog } = useOxy();
  const { canUsePrivateApi } = useAuthGate();
  const { ask } = useAskAgent();

  const handlePress = useCallback(() => {
    if (!canUsePrivateApi) {
      openAccountDialog('signin');
      return;
    }
    ask();
  }, [ask, canUsePrivateApi, openAccountDialog]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t('topbar.askAlia')}
      className="h-10 w-10 items-center justify-center rounded-full"
    >
      <AliaAvatarIcon width={24} height={24} fill={theme.colors.text} />
    </Pressable>
  );
};
