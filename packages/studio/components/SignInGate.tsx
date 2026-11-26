import { type ReactNode, useCallback } from 'react';
import { Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

/**
 * Gates creator-only content behind an authenticated Oxy session. Waits for the
 * cold boot (`isPrivateApiPending`) before deciding, then either renders the
 * sign-in prompt or the protected children once `canUsePrivateApi` is true.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const { canUsePrivateApi, isPrivateApiPending, openAccountDialog } = useOxy();
  const theme = useTheme();

  const onSignIn = useCallback(() => {
    openAccountDialog('signin');
  }, [openAccountDialog]);

  if (isPrivateApiPending) {
    return (
      <View style={styles.centered}>
        <Loading />
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View style={styles.centered2}>
        <View style={styles.centered3}>
          <MaterialCommunityIcons
            name="microphone-variant"
            size={30}
            color={theme.colors.primary}
          />
        </View>
        <Text style={styles.title}>Syra Studio</Text>
        <Text style={styles.mutedText}>
          Sign in with your Oxy account to manage your podcast shows, upload episodes, and get a
          public RSS feed.
        </Text>
        <Button
          onPress={onSignIn}
          icon={<MaterialCommunityIcons name="login" size={18} color="#fff" />}
          tone="accent"
          appearance="solid"
        >
          Sign in
        </Button>
      </View>
    );
  }

  return <>{children}</>;
}

const useStyles = createTokenStyles((t) => ({
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
  },
  centered2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
    paddingHorizontal: 32,
  },
  centered3: {
    marginBottom: 20,
    height: 64,
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  title: {
    marginBottom: 8,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: 700,
    color: t.foreground,
    lineHeight: 32,
  },
  mutedText: {
    marginBottom: 24,
    maxWidth: 420,
    textAlign: 'center',
    fontSize: 16,
    color: t.mutedForeground,
    lineHeight: 24,
  },
}));
