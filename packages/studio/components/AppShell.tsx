import { type ReactNode, useCallback } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, usePathname, type Href } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy, ProfileButton } from '@oxy.so/services/ui/client';
import { useResponsive } from '@/hooks/useResponsive';
import { cn } from '@/lib/utils';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
  { label: 'Go Live', href: '/live', icon: 'access-point', matchPrefix: '/live' },
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
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <View style={styles.centered}>
        <MaterialCommunityIcons name="microphone-variant" size={18} color="#fff" />
      </View>
      <View>
        <Text style={styles.title}>Syra</Text>
        <Text style={styles.mutedText}>Studio</Text>
      </View>
    </View>
  );
}

// Account trigger. ProfileButton owns all three auth states (undetermined
// skeleton, signed-in row + account switcher, signed-out "Sign in") and the
// device-account switcher menu. `expanded` renders the full row (avatar + name +
// handle) in the sidebar; the collapsed avatar-only variant fits the mobile
// top-bar slot. "Manage your Oxy account" always opens the SDK's ManageAccount
// screen; add-account opens the account dialog.
function AccountButton({ expanded = true }: { expanded?: boolean }) {
  const { openAccountDialog } = useOxy();
  const onAddAccount = useCallback(() => {
    openAccountDialog('add');
  }, [openAccountDialog]);

  return <ProfileButton expanded={expanded} avatarSize={34} onAddAccount={onAddAccount} />;
}

function NavButton({
  item,
  active,
  onPress,
}: {
  item: NavItem;
  active: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
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
      <Text
        className={cn('text-sm flex-1', active ? 'text-primary font-semibold' : 'text-foreground')}
      >
        {item.label}
      </Text>
      {item.comingSoon ? <Text style={styles.mutedText2}>Soon</Text> : null}
    </Pressable>
  );
}

function Sidebar() {
  const styles = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  return (
    <View style={styles.surface}>
      <View style={styles.stack}>
        <View style={styles.section}>
          <Brand />
        </View>
        <View style={styles.stack2}>
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
      <View style={styles.container}>
        <AccountButton />
      </View>
    </View>
  );
}

function MobileTopBar() {
  const styles = useStyles();
  const router = useRouter();
  return (
    <View style={styles.row2}>
      <Pressable onPress={() => router.push('/')} className="active:opacity-70">
        <Brand />
      </Pressable>
      <View style={styles.container2}>
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
  const styles = useStyles();
  const { isWide } = useResponsive();

  if (isWide) {
    return (
      <View style={styles.row3}>
        <Sidebar />
        <View style={styles.fill}>{children}</View>
      </View>
    );
  }

  return (
    <View style={styles.surface2}>
      <MobileTopBar />
      <View style={styles.fill}>{children}</View>
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
  const styles = useStyles();
  const theme = useTheme();
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {(title || onBack || actions) && (
        <View style={styles.row4}>
          <View style={styles.row5}>
            {onBack ? (
              <Pressable
                onPress={onBack}
                className="w-9 h-9 rounded-full items-center justify-center active:bg-surface"
              >
                <MaterialCommunityIcons name="arrow-left" size={22} color={theme.colors.text} />
              </Pressable>
            ) : null}
            <View style={styles.fill}>
              {title ? <Text style={styles.title2}>{title}</Text> : null}
              {subtitle ? <Text style={styles.mutedText3}>{subtitle}</Text> : null}
            </View>
          </View>
          {actions}
        </View>
      )}
      {children}
    </ScrollView>
  );
}

const useStyles = createTokenStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  centered: {
    height: 32,
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: t.primary,
  },
  title: { fontSize: 16, fontWeight: 700, color: t.foreground, lineHeight: 20 },
  mutedText: { fontSize: 11, color: t.mutedForeground, lineHeight: 13.75 },
  mutedText2: {
    fontSize: 10,
    color: t.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 0.25,
  },
  surface: {
    height: '100%',
    width: 260,
    justifyContent: 'space-between',
    borderRightWidth: 1,
    borderColor: t.border,
    backgroundColor: t.background,
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  stack: { gap: 24 },
  section: { paddingHorizontal: 8 },
  stack2: { gap: 4 },
  container: { borderTopWidth: 1, borderColor: t.border, paddingTop: 8 },
  row2: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderColor: t.border,
    backgroundColor: t.background,
    paddingHorizontal: 16,
  },
  container2: { alignItems: 'flex-end' },
  row3: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'row',
    backgroundColor: t.background,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  surface2: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  content: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  row4: {
    marginBottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  row5: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title2: { fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText3: { marginTop: 2, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
}));
