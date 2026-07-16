import { type ReactNode, useCallback } from 'react';
import { Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';

/**
 * Gates creator-only content behind an authenticated Oxy session. Waits for the
 * cold boot (`isPrivateApiPending`) before deciding, then either renders the
 * sign-in prompt or the protected children once `canUsePrivateApi` is true.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const { canUsePrivateApi, isPrivateApiPending, openAccountDialog } = useOxy();
  const theme = useTheme();

  const onSignIn = useCallback(() => {
    openAccountDialog('signin');
  }, [openAccountDialog]);

  if (isPrivateApiPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading />
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-5">
          <MaterialCommunityIcons name="microphone-variant" size={30} color={theme.colors.primary} />
        </View>
        <Text className="text-2xl font-bold text-foreground text-center mb-2">Syra Studio</Text>
        <Text className="text-base text-muted-foreground text-center mb-6 max-w-[420px]">
          Sign in with your Oxy account to manage your podcast shows, upload episodes, and get a public RSS feed.
        </Text>
        <Button variant="primary" onPress={onSignIn} icon={<MaterialCommunityIcons name="login" size={18} color="#fff" />}>
          Sign in
        </Button>
      </View>
    );
  }

  return <>{children}</>;
}
