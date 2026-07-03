import { type ReactNode, useCallback } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, usePathname, type Href } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy, ProfileButton } from '@oxyhq/services';
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
  { label: 'Music', href: '/music', icon: 'music', matchPrefix: '/music' },
  { label: 'Podcasts', href: '/', icon: 'podcast', matchPrefix: '/podcasts' },
  { label: 'New podcast', href: '/podcasts/new', icon: 'plus-circle-outline' },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') {
    return pathname === '/' || (item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false);
  }
  if (item.matchPrefix) {
    return pathname === item.href || pathname.startsWith(item.matchPrefix);
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
        <Text className="text-muted-foreground text-[11px] leading-tight">Studio</Text>
      </View>
    </View>
  );
}

// Account trigger. ProfileButton owns all three auth states (undetermined
// skeleton, signed-in row + account switcher, signed-out "Sign in") and the
// device-account switcher menu. `expanded` renders the full row (avatar + name +
// handle) in the sidebar; the collapsed avatar-only variant fits the mobile
// top-bar slot. Manage goes to the ManageAccount sheet (this studio has no
// standalone settings route); add-account opens the OxyAuth sheet.
function AccountButton({ expanded = true }: { expanded?: boolean }) {
  const { showBottomSheet } = useOxy();
  const onNavigateManage = useCallback(() => {
    showBottomSheet?.('ManageAccount');
  }, [showBottomSheet]);
  const onAddAccount = useCallback(() => {
    showBottomSheet?.('OxyAuth');
  }, [showBottomSheet]);

  return (
    <ProfileButton
      expanded={expanded}
      avatarSize={34}
      onNavigateManage={onNavigateManage}
      onAddAccount={onAddAccount}
    />
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
      <View className="items-end">
        <AccountButton expanded={false} />
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
