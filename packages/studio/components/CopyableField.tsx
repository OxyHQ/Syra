import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import { copyToClipboard } from '@/utils/clipboard';
import { toast } from '@oxy.so/bloom/toast';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

/**
 * Read-only value (e.g. the generated public RSS URL) with a one-tap copy
 * action. Creators paste this into Apple Podcasts / Spotify for Creators.
 */
export function CopyableField({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
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
      <Text style={styles.text}>{label}</Text>
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.mutedText}>
          {value}
        </Text>
        <Pressable
          onPress={onCopy}
          accessibilityRole="button"
          accessibilityLabel="Copy RSS feed URL"
          style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons name="content-copy" size={15} color={theme.colors.primary} />
          <Text style={styles.title}>Copy</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pressed: { opacity: 0.7 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mutedText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  title: { fontSize: 12, fontWeight: 600, color: t.primary, lineHeight: 16 },
}));
