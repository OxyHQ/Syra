import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Avatar } from '@oxyhq/bloom/avatar';
import type { User } from '@oxyhq/core';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUserSearch } from '@/hooks/useUserSearch';
import { cn } from '@/lib/utils';

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
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-1 rounded-lg px-2.5 py-1.5',
        active ? 'bg-primary' : 'bg-primary/10',
      )}
    >
      {active ? <MaterialCommunityIcons name="check" size={13} color="#fff" /> : null}
      <Text className={cn('text-xs font-semibold', active ? 'text-white' : 'text-primary')}>{label}</Text>
    </Pressable>
  );
}

function PersonChip({ user, onRemove }: { user: User; onRemove: () => void }) {
  const theme = useTheme();
  return (
    <View className="flex-row items-center gap-2 rounded-full border border-border bg-surface pl-1 pr-2 py-1">
      <Avatar source={user.avatar ?? undefined} variant="thumb" name={user.name.displayName} size={24} />
      <Text numberOfLines={1} className="text-xs text-foreground max-w-[140px]">
        {user.name.displayName}
      </Text>
      <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Remove ${user.name.displayName}`}>
        <MaterialCommunityIcons name="close-circle" size={16} color={theme.colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function ChipSection({ title, people, onRemove }: { title: string; people: User[]; onRemove: (id: string) => void }) {
  if (people.length === 0) return null;
  return (
    <View className="mt-3">
      <Text className="text-xs font-medium text-muted-foreground mb-1.5">{title}</Text>
      <View className="flex-row flex-wrap gap-2">
        {people.map((user) => (
          <PersonChip key={user.id} user={user} onRemove={() => onRemove(user.id)} />
        ))}
      </View>
    </View>
  );
}

/**
 * Hosts & Guests picker. Searches Oxy users (`oxyServices.searchProfiles`) and
 * lets the creator add each result to the Hosts or Guests list. Only real Oxy
 * users can be added — there is no free-text entry — so the ids submitted always
 * pass the backend's Oxy validation.
 */
export function HostsGuestsPicker({ value, onChange }: { value: HostsGuests; onChange: (next: HostsGuests) => void }) {
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
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1">Hosts &amp; Guests</Text>
      <Text className="text-xs text-muted-foreground mb-2">
        Search Oxy users to credit. Only real Oxy accounts can be added.
      </Text>

      <View className="flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3 h-11">
        <MaterialCommunityIcons name="account-search-outline" size={18} color={theme.colors.textSecondary} />
        <TextInput
          className="flex-1 text-foreground"
          placeholder="Search by name or @username"
          placeholderTextColor={theme.colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {isFetching ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search">
            <MaterialCommunityIcons name="close" size={18} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {showResults ? (
        <View className="mt-2 rounded-xl border border-border bg-surface overflow-hidden">
          {emptyResults ? (
            <Text className="text-sm text-muted-foreground px-3 py-3">No matching Oxy users.</Text>
          ) : (
            (results ?? []).map((user) => {
              const isHost = byId(hosts, user.id);
              const isGuest = byId(guests, user.id);
              return (
                <View key={user.id} className="flex-row items-center gap-3 px-3 py-2.5 border-b border-border">
                  <Avatar source={user.avatar ?? undefined} variant="thumb" name={user.name.displayName} size={36} />
                  <View className="flex-1">
                    <Text numberOfLines={1} className="text-sm font-medium text-foreground">
                      {user.name.displayName}
                    </Text>
                    <Text numberOfLines={1} className="text-xs text-muted-foreground">
                      @{user.username}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
                    <RoleButton label="Host" active={isHost} onPress={() => assign(user, 'host')} />
                    <RoleButton label="Guest" active={isGuest} onPress={() => assign(user, 'guest')} />
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
