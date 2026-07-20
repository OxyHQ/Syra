import React, { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { TOP_BAR_HEIGHT } from '@/components/TopBar';

/**
 * App-level offline indicator.
 *
 * Why this exists: with `networkMode: 'online'` (see providers/constants.ts) an
 * offline query does not fail — it parks at `fetchStatus: 'paused'` while
 * `status` stays `'pending'`. So no error is ever thrown, the global
 * `QueryCache.onError` never fires, and every skeleton in the app simply stays
 * up forever with no explanation. This banner is the only signal the user gets.
 *
 * Why a persistent banner and not a toast: being offline is a *condition*, not
 * an event. A toast auto-dismisses and leaves the user staring at the same
 * permanent skeletons with the explanation gone.
 *
 * Connectivity is read from React Query's `onlineManager`, which `app/_layout.tsx`
 * already drives from the single NetInfo subscription — this adds no second
 * network-detection path, and it stays in lockstep with the manager that decides
 * whether queries run at all. `useSyncExternalStore` is required rather than a
 * plain read: `onlineManager.isOnline()` is external mutable state, so reading it
 * in a memoized position would let the React Compiler freeze the first value.
 *
 * Translated via `t()` with an explicit `defaultValue`. This component mounts
 * unconditionally in the providers tree, which used to make `t()` unsafe here:
 * react-i18next defaults `useSuspense` to true, so a boot-mounted `t()` would
 * suspend before any Suspense boundary existed and hang the app on a white
 * screen. `lib/i18n.ts` now sets `useSuspense: false`, so the call is safe — and
 * the `defaultValue` covers the window before i18n finishes initializing, when
 * `t()` would otherwise render the raw key.
 */

const subscribeToOnlineManager = (onStoreChange: () => void) => onlineManager.subscribe(onStoreChange);
const getIsOnline = () => onlineManager.isOnline();
// Static web renders have no connectivity signal; assume online so the banner
// never flashes into the markup before hydration corrects it.
const getIsOnlineForServer = () => true;

export function OfflineBanner() {
    const { t } = useTranslation();
    const isOnline = useSyncExternalStore(subscribeToOnlineManager, getIsOnline, getIsOnlineForServer);
    const insets = useSafeAreaInsets();
    const theme = useTheme();

    const styles = useMemo(
        () =>
            StyleSheet.create({
                container: {
                    position: 'absolute',
                    // Sits directly below the TopBar, which is `TOP_BAR_HEIGHT + insets.top`
                    // tall (web insets are 0, so this collapses to the base height there).
                    // Anchoring to the top keeps it clear of the player bar and the mobile
                    // bottom nav.
                    top: insets.top + TOP_BAR_HEIGHT,
                    left: 0,
                    right: 0,
                    alignItems: 'center',
                    // Below the TopBar's own z-index (1000) so navigation always wins.
                    zIndex: 900,
                },
                banner: {
                    marginHorizontal: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: theme.colors.backgroundTertiary,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme.colors.border,
                },
                text: {
                    color: theme.colors.text,
                    fontSize: 13,
                    textAlign: 'center',
                },
            }),
        [insets.top, theme.colors.backgroundTertiary, theme.colors.border, theme.colors.text],
    );

    if (isOnline) {
        return null;
    }

    // `pointerEvents="none"` guarantees the banner can never swallow a tap meant
    // for the content underneath it.
    return (
        <View style={styles.container} pointerEvents="none" accessibilityRole="alert">
            <View style={styles.banner}>
                <Text style={styles.text}>
                    {t('common.offline', { defaultValue: "You're offline. Showing saved content." })}
                </Text>
            </View>
        </View>
    );
}
