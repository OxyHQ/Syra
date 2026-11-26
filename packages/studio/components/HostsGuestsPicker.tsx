import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { User } from '@oxy.so/core';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUserSearch } from '@/hooks/useUserSearch';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

export interface HostsGuests {
  hosts: User[];
  guests: User[];
}

type Role = 'host' | 'guest';

function byId(list: User[], id: string): boolean {
  return list.some((u) => u.id === id);
}

function RoleButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.role, active ? styles.roleActive : styles.roleIdle]}
    >
      {active ? <MaterialCommunityIcons name="check" size={13} color="#fff" /> : null}
      <Text style={[styles.roleText, active ? styles.roleTextActive : styles.roleTextIdle]}>
        {label}
      </Text>
    </Pressable>
  );
}

function PersonChip({ user, onRemove }: { user: User; onRemove: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Avatar
        source={user.avatar ?? undefined}
        variant="thumb"
        name={user.name.displayName}
        size={24}
      />
      <Text numberOfLines={1} style={styles.text}>
        {user.name.displayName}
      </Text>
      <Pressable
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${user.name.displayName}`}
      >
        <MaterialCommunityIcons name="close-circle" size={16} color={theme.colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function ChipSection({
  title,
  people,
  onRemove,
}: {
  title: string;
  people: User[];
  onRemove: (id: string) => void;
}) {
  const styles = useStyles();
  if (people.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.mutedText}>{title}</Text>
      <View style={styles.row2}>
        {people.map((user) => (
          <PersonChip key={user.id} user={user} onRemove={() => onRemove(user.id)} />
        ))}
      </View>
    </View>
  );
}

/**
 * Hosts & Guests picker. Searches Oxy users (`oxyServices.users.search`) and
 * lets the creator add each result to the Hosts or Guests list. Only real Oxy
 * users can be added — there is no free-text entry — so the ids submitted always
 * pass the backend's Oxy validation.
 */
export function HostsGuestsPicker({
  value,
  onChange,
}: {
  value: HostsGuests;
  onChange: (next: HostsGuests) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 300);
  const { data: results, isFetching } = useUserSearch(debounced);

  const { hosts, guests } = value;

  const assign = useCallback(
    (user: User, role: Role) => {
      // A person is either a host or a guest, not both — assigning one role
      // removes them from the other list.
      const hostsWithout = hosts.filter((u) => u.id !== user.id);
      const guestsWithout = guests.filter((u) => u.id !== user.id);
      if (role === 'host') {
        onChange({ hosts: [...hostsWithout, user], guests: guestsWithout });
      } else {
        onChange({ hosts: hostsWithout, guests: [...guestsWithout, user] });
      }
    },
    [hosts, guests, onChange],
  );

  const removeHost = useCallback(
    (id: string) => onChange({ hosts: hosts.filter((u) => u.id !== id), guests }),
    [hosts, guests, onChange],
  );
  const removeGuest = useCallback(
    (id: string) => onChange({ hosts, guests: guests.filter((u) => u.id !== id) }),
    [hosts, guests, onChange],
  );

  const showResults = debounced.trim().length >= 2;
  const emptyResults = useMemo(
    () => showResults && !isFetching && (results?.length ?? 0) === 0,
    [showResults, isFetching, results],
  );

  return (
    <View style={styles.section2}>
      <Text style={styles.text2}>Hosts &amp; Guests</Text>
      <Text style={styles.mutedText2}>
        Search Oxy users to credit. Only real Oxy accounts can be added.
      </Text>

      <View style={styles.row3}>
        <MaterialCommunityIcons
          name="account-search-outline"
          size={18}
          color={theme.colors.textSecondary}
        />
        <TextInput
          style={styles.container}
          placeholder="Search by name or @username"
          placeholderTextColor={theme.colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {isFetching ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
        {query.length > 0 ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <MaterialCommunityIcons name="close" size={18} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {showResults ? (
        <View style={styles.surface}>
          {emptyResults ? (
            <Text style={styles.mutedText3}>No matching Oxy users.</Text>
          ) : (
            (results ?? []).map((user) => {
              const isHost = byId(hosts, user.id);
              const isGuest = byId(guests, user.id);
              return (
                <View key={user.id} style={styles.row4}>
                  <Avatar
                    source={user.avatar ?? undefined}
                    variant="thumb"
                    name={user.name.displayName}
                    size={36}
                  />
                  <View style={styles.fill}>
                    <Text numberOfLines={1} style={styles.text3}>
                      {user.name.displayName}
                    </Text>
                    <Text numberOfLines={1} style={styles.mutedText4}>
                      @{user.username}
                    </Text>
                  </View>
                  <View style={styles.row5}>
                    <RoleButton label="Host" active={isHost} onPress={() => assign(user, 'host')} />
                    <RoleButton
                      label="Guest"
                      active={isGuest}
                      onPress={() => assign(user, 'guest')}
                    />
                  </View>
                </View>
              );
            })
          )}
        </View>
      ) : null}

      <ChipSection title="Hosts" people={hosts} onRemove={removeHost} />
      <ChipSection title="Guests" people={guests} onRemove={removeGuest} />
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  role: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  roleActive: { backgroundColor: t.primary },
  roleIdle: { backgroundColor: tokenAlpha(t.primary, 0.1) },
  roleText: { fontSize: 12, fontWeight: 600, lineHeight: 16 },
  roleTextActive: { color: '#fff' },
  roleTextIdle: { color: t.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingVertical: 4,
    paddingRight: 8,
    paddingLeft: 4,
  },
  text: { maxWidth: 140, fontSize: 12, color: t.foreground, lineHeight: 16 },
  section: { marginTop: 12 },
  mutedText: {
    marginBottom: 6,
    fontSize: 12,
    fontWeight: 500,
    color: t.mutedForeground,
    lineHeight: 16,
  },
  row2: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  section2: { marginBottom: 16 },
  text2: { marginBottom: 4, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  mutedText2: { marginBottom: 8, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  row3: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 12,
  },
  container: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', color: t.foreground },
  surface: {
    marginTop: 8,
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
  },
  mutedText3: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  row4: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  text3: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  mutedText4: { fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  row5: { flexDirection: 'row', alignItems: 'center', gap: 6 },
}));
