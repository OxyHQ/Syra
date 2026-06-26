import { type ReactNode, useCallback } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, usePathname, type Href } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useOxy } from '@oxyhq/services';
import { useResponsive } from '@/hooks/useResponsive';
import { cn } from '@/lib/utils';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

interface NavItem {
  label: string;
  href: Href;
  icon: IconName;
  /** Match child routes (e.g. `/podcasts/123`) to the same nav entry. */
  matchPrefix?: string;
  comingSoon?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: 'view-dashboard-outline', matchPrefix: '/podcasts' },
  { label: 'New show', href: '/podcasts/new', icon: 'plus-circle-outline' },
  { label: 'Music', href: '/music', icon: 'music', comingSoon: true },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') {
    return pathname === '/' || (item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false);
  }
  return pathname === item.href;
}

function Brand() {
  return (
    <View className="flex-row items-center gap-2">
      <View className="w-8 h-8 rounded-lg bg-primary items-center justify-center">
        <MaterialCommunityIcons name="microphone-variant" size={18} color="#fff" />
      </View>
      <View>
        <Text className="text-foreground font-bold text-base leading-tight">Syra</Text>
        <Text className="text-muted-foreground text-[11px] leading-tight">for Creators</Text>
      </View>
    </View>
  );
}

function AccountButton() {
  const { user, isAuthenticated, showBottomSheet } = useOxy();
  const onPress = useCallback(() => {
    showBottomSheet?.(isAuthenticated ? 'ManageAccount' : 'OxyAuth');
  }, [isAuthenticated, showBottomSheet]);

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-xl px-2 py-2 active:opacity-70"
    >
      <Avatar source={user?.avatar ?? undefined} name={user?.name?.displayName ?? user?.username} size={34} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-foreground text-sm font-medium">
          {isAuthenticated ? (user?.name?.displayName ?? user?.username ?? 'Your account') : 'Sign in'}
        </Text>
        <Text numberOfLines={1} className="text-muted-foreground text-xs">
          {isAuthenticated ? `@${user?.username ?? ''}` : 'Manage your shows'}
        </Text>
      </View>
    </Pressable>
  );
}

function NavButton({ item, active, onPress }: { item: NavItem; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={item.comingSoon}
      className={cn(
        'flex-row items-center gap-3 rounded-xl px-3 py-2.5',
        active ? 'bg-primary/10' : 'active:bg-surface',
        item.comingSoon ? 'opacity-50' : '',
      )}
    >
      <MaterialCommunityIcons
        name={item.icon}
        size={20}
        color={active ? theme.colors.primary : theme.colors.text}
      />
      <Text className={cn('text-sm flex-1', active ? 'text-primary font-semibold' : 'text-foreground')}>
        {item.label}
      </Text>
      {item.comingSoon ? (
        <Text className="text-[10px] uppercase tracking-wide text-muted-foreground">Soon</Text>
      ) : null}
    </Pressable>
  );
}

function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <View className="w-[260px] h-full border-r border-border bg-background px-3 py-4 justify-between">
      <View className="gap-6">
        <View className="px-2">
          <Brand />
        </View>
        <View className="gap-1">
          {NAV_ITEMS.map((item) => (
            <NavButton
              key={item.label}
              item={item}
              active={isActive(pathname, item)}
              onPress={() => router.push(item.href)}
            />
          ))}
        </View>
      </View>
      <View className="border-t border-border pt-2">
        <AccountButton />
      </View>
    </View>
  );
}

function MobileTopBar() {
  const router = useRouter();
  return (
    <View className="flex-row items-center justify-between border-b border-border bg-background px-4 h-14">
      <Pressable onPress={() => router.push('/')} className="active:opacity-70">
        <Brand />
      </Pressable>
      <View className="w-[44px] items-end">
        <AccountButton />
      </View>
    </View>
  );
}

/**
 * Responsive chrome: a persistent left sidebar on wide screens, a compact top
 * bar on narrow screens. Routed content is rendered as `children` (the Slot).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { isWide } = useResponsive();

  if (isWide) {
    return (
      <View className="flex-1 flex-row bg-background">
        <Sidebar />
        <View className="flex-1">{children}</View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <MobileTopBar />
      <View className="flex-1">{children}</View>
    </View>
  );
}

/**
 * Page-level scroll container with a centered max-width column and an optional
 * header (title, subtitle, back button, and trailing actions).
 */
export function ScreenContainer({
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-5 py-6 w-full max-w-[820px] self-center"
      keyboardShouldPersistTaps="handled"
    >
      {(title || onBack || actions) && (
        <View className="flex-row items-center justify-between mb-6 gap-3">
          <View className="flex-row items-center gap-3 flex-1">
            {onBack ? (
              <Pressable onPress={onBack} className="w-9 h-9 rounded-full items-center justify-center active:bg-surface">
                <MaterialCommunityIcons name="arrow-left" size={22} color={theme.colors.text} />
              </Pressable>
            ) : null}
            <View className="flex-1">
              {title ? <Text className="text-2xl font-bold text-foreground">{title}</Text> : null}
              {subtitle ? <Text className="text-sm text-muted-foreground mt-0.5">{subtitle}</Text> : null}
            </View>
          </View>
          {actions}
        </View>
      )}
      {children}
    </ScrollView>
  );
}
