import React from 'react';
import { StyleSheet, Text, Pressable, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Mobile Bottom Navigation Bar
 * Spotify-like bottom navigation with Home, Search, and Your Library tabs
 */
export const MobileBottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  const tabs: { name: string; icon: string; iconOutline: string; route: '/' | '/search' | '/library' }[] = [
    {
      name: 'Home',
      icon: 'home',
      iconOutline: 'home-outline',
      route: '/',
    },
    {
      name: 'Search',
      icon: 'magnify',
      iconOutline: 'magnify',
      route: '/search',
    },
    {
      name: 'Your Library',
      icon: 'book-music',
      iconOutline: 'book-music-outline',
      route: '/library',
    },
  ];

  const isActive = (route: string) => {
    if (route === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(route);
  };

  return (
    <LinearGradient
      colors={['transparent', '#000000']}
      locations={[0, 1]}
      style={[styles.container, { 
        paddingBottom: Platform.OS === 'web' ? 8 : 8 + insets.bottom,
        height: 60 + (Platform.OS === 'web' ? 8 : 8 + insets.bottom),
      }]}
    >
      {tabs.map((tab) => {
        const active = isActive(tab.route);
        return (
          <Pressable
            key={tab.route}
            onPress={() => router.push(tab.route)}
            style={styles.tab}
          >
            <MaterialCommunityIcons
              name={active ? tab.icon as any : tab.iconOutline as any}
              size={24}
              color={active ? "#FFFFFF" : "#999999"}
            />
            <Text
              style={[
                styles.tabLabel,
                {
                  color: active ? "#FFFFFF" : "#999999",
                },
              ]}
            >
              {tab.name}
            </Text>
          </Pressable>
        );
      })}
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    ...Platform.select({
      web: {
        position: 'fixed' as any,
        height: 60,
      },
      default: {
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      },
    }),
    zIndex: 1000,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
});

