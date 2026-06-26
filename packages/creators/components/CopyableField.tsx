import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { copyToClipboard } from '@/utils/clipboard';
import { toast } from '@/lib/sonner';

/**
 * Read-only value (e.g. the generated public RSS URL) with a one-tap copy
 * action. Creators paste this into Apple Podcasts / Spotify for Creators.
 */
export function CopyableField({ label, value }: { label: string; value: string }) {
  const theme = useTheme();

  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      toast.success('RSS feed URL copied');
    } else {
      toast.error('Could not copy — select and copy the URL manually');
    }
  }, [value]);

  return (
    <View>
      <Text className="text-sm font-medium text-foreground mb-1.5">{label}</Text>
      <View className="flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
        <Text numberOfLines={1} className="flex-1 text-sm text-muted-foreground">
          {value}
        </Text>
        <Pressable
          onPress={onCopy}
          accessibilityRole="button"
          accessibilityLabel="Copy RSS feed URL"
          className="flex-row items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 active:opacity-70"
        >
          <MaterialCommunityIcons name="content-copy" size={15} color={theme.colors.primary} />
          <Text className="text-xs font-semibold text-primary">Copy</Text>
        </Pressable>
      </View>
    </View>
  );
}
