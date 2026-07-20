import React, { useCallback } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation } from '@tanstack/react-query';
import { getAccountDisplayName } from '@oxyhq/core';
import { useOxy } from '@oxyhq/services';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxyhq/bloom/settings-list';
import { Switch } from '@oxyhq/bloom/switch';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxyhq/bloom/segmented-control';
import {
  APP_COLOR_PRESETS,
  useBloomTheme,
  type AppColorName,
} from '@oxyhq/bloom/theme';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { ThemedView } from '@/components/ThemedView';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuthGate } from '@/hooks/useAuthGate';
import { Slider } from '@/components/Slider';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { RowIcon } from '@/components/settings/RowIcon';
import { useMusicPreferences } from '@/hooks/useMusicPreferences';
import {
  useCurrentUserPrivacySettings,
  useUpdatePrivacySettingsCache,
  type PrivacySettings,
} from '@/hooks/usePrivacySettings';
import {
  useMyAppearanceSettings,
  useUpdateMyAppearanceSettings,
} from '@/store/appearanceStore';
import { STORAGE_KEYS } from '@/lib/constants';
import i18n from '@/lib/i18n';
import { authenticatedClient } from '@/utils/api';
import { confirmDialog } from '@/utils/alerts';
import { createScopedLogger } from '@/utils/logger';
import { Storage } from '@/utils/storage';

type AudioQuality = 'low' | 'normal' | 'high' | 'very_high';
type ProfileVisibility = 'public' | 'private' | 'followers_only';

type RowIconName = React.ComponentProps<typeof RowIcon>['name'];

const logger = createScopedLogger('SettingsScreen');

const STUDIO_URL = 'https://studio.syra.fm';

const LANGUAGE_OPTIONS: readonly { label: string; value: string }[] = [
  { label: 'English', value: 'en-US' },
  { label: 'Español', value: 'es-ES' },
  { label: 'Italiano', value: 'it-IT' },
];

interface SettingsControlBlockProps {
  icon: RowIconName;
  title: string;
  description?: string;
  children: React.ReactNode;
}

const SettingsControlBlock: React.FC<SettingsControlBlockProps> = ({
  icon,
  title,
  description,
  children,
}) => (
  <View style={styles.controlBlock}>
    <View style={styles.controlHeader}>
      <RowIcon name={icon} />
      <View style={styles.controlText}>
        <Text className="text-[15px] font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {description ? (
          <Text className="text-[13px] leading-[17px] text-muted-foreground" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
    </View>
    <View style={styles.controlContent}>{children}</View>
  </View>
);

const SettingsScreen: React.FC = () => {
  const router = useRouter();
  const { user, logout, showBottomSheet, openAccountDialog } = useOxy();
  // Session state comes from the bounded gate, never from raw
  // `isPrivateApiPending` — an unresolved session must reach a terminal state
  // instead of parking this screen on "Loading account settings" forever.
  const gate = useAuthGate();
  const { canUsePrivateApi } = gate;
  const {
    preferences: musicPreferences,
    updatePreferences: updateMusicPreferences,
  } = useMusicPreferences();
  const privacySettings = useCurrentUserPrivacySettings();
  const updatePrivacySettingsCache = useUpdatePrivacySettingsCache();
  const { data: appearanceSettings } = useMyAppearanceSettings(canUsePrivateApi);
  const { mutateAsync: updateAppearanceSettings } = useUpdateMyAppearanceSettings();
  const { colorPreset, mode: bloomMode, setMode, setColorPreset } = useBloomTheme();

  const appVersion = Constants.expoConfig?.version ?? '2.0.0';
  const userName = getAccountDisplayName(user);
  const username = user?.username;
  const usernameLabel = username ? `@${username}` : 'Signed in to Syra';

  const themeMode: 'system' | 'light' | 'dark' =
    bloomMode === 'light' || bloomMode === 'dark' ? bloomMode : 'system';

  const handleLanguageChange = useCallback(async (language: string) => {
    try {
      await i18n.changeLanguage(language);
      await Storage.set(STORAGE_KEYS.LANGUAGE_PREFERENCE, language);
    } catch (error) {
      logger.error('Failed to change language', { error });
      Alert.alert('Error', 'Failed to change language. Please try again.');
    }
  }, []);

  const requirePrivateSession = useCallback((): boolean => {
    if (canUsePrivateApi) return true;
    openAccountDialog('signin');
    Alert.alert('Log in required', 'Please log in before changing account settings.');
    return false;
  }, [canUsePrivateApi, openAccountDialog]);

  const handleViewProfile = useCallback(() => {
    if (!username) return;
    router.push(`/u/${username}`);
  }, [router, username]);

  const handleManageAccount = useCallback(() => {
    showBottomSheet?.('ManageAccount');
  }, [showBottomSheet]);

  const handleOpenStudio = useCallback(() => {
    Linking.openURL(STUDIO_URL).catch((error) => {
      logger.warn('Failed to open Syra Studio', error);
    });
  }, []);

  const handleMusicPreferenceUpdate = useCallback((updates: Parameters<typeof updateMusicPreferences>[0]) => {
    if (!requirePrivateSession()) return;
    void updateMusicPreferences(updates);
  }, [requirePrivateSession, updateMusicPreferences]);

  const handleThemeModeChange = useCallback((mode: 'system' | 'light' | 'dark') => {
    if (!requirePrivateSession()) return;
    setMode(mode);
    void updateAppearanceSettings({
      appearance: {
        themeMode: mode,
        primaryColor: appearanceSettings?.appearance?.primaryColor,
      },
    });
  }, [appearanceSettings?.appearance?.primaryColor, requirePrivateSession, setMode, updateAppearanceSettings]);

  const handleColorChange = useCallback((name: AppColorName) => {
    if (!requirePrivateSession()) return;
    setColorPreset(name);
    void updateAppearanceSettings({
      appearance: {
        themeMode: appearanceSettings?.appearance?.themeMode ?? 'system',
        primaryColor: APP_COLOR_PRESETS[name].hex,
      },
    });
  }, [appearanceSettings?.appearance?.themeMode, requirePrivateSession, setColorPreset, updateAppearanceSettings]);

  const updatePrivacySettingsMutation = useMutation({
    mutationFn: async (updates: Partial<PrivacySettings>) => {
      if (!canUsePrivateApi) {
        throw new Error('Log in required');
      }
      const newSettings: PrivacySettings = { ...privacySettings, ...updates };
      await authenticatedClient.put('/profile/settings', { privacy: newSettings });
      await updatePrivacySettingsCache(newSettings);
      return newSettings;
    },
    onError: (error) => {
      logger.error('Failed to update privacy settings', { error });
      Alert.alert('Error', 'Failed to update privacy settings.');
    },
  });

  const handlePrivacyUpdate = useCallback((updates: Partial<PrivacySettings>) => {
    if (!requirePrivateSession()) return;
    updatePrivacySettingsMutation.mutate(updates);
  }, [requirePrivateSession, updatePrivacySettingsMutation]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: 'Log out',
      message: 'Are you sure you want to log out?',
      okText: 'Log out',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await logout();
      router.replace('/');
    } catch (error) {
      logger.error('Logout failed', { error });
      Alert.alert('Error', 'Failed to log out. Please try again.');
    }
  }, [logout, router]);

  const handleClearCache = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: 'Clear Cache',
      message: 'This will clear all cached data. You may need to reload some content.',
      okText: 'Clear',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      const keys = await AsyncStorage.getAllKeys();
      const keysToClear = keys.filter((key) =>
        key.includes('cache') ||
        key.includes('_cache') ||
        key.startsWith('@syra') ||
        key.startsWith('@musico') ||
        key.startsWith('oxy_appearance_settings') ||
        key.startsWith('syra_music_preferences') ||
        key.startsWith('musico_music_preferences'),
      );
      await Promise.all(keysToClear.map((key) => AsyncStorage.removeItem(key)));
      Alert.alert('Success', 'Cache cleared successfully.');
    } catch (error) {
      logger.error('Clear cache failed', { error });
      Alert.alert('Error', 'Failed to clear cache. Please try again.');
    }
  }, []);

  // Terminal auth failure — the session never resolved within the gate's bound.
  if (gate.isTimedOut) {
    return (
      <>
        <SEO title="Settings - Syra" description="App settings and preferences" />
        <ThemedView className="flex-1">
          <EmptyState
            containerStyle={styles.gateState}
            icon={{ name: 'cloud-offline-outline' }}
            error={{
              title: 'Session unavailable',
              message: 'We could not confirm your session, so your settings stayed hidden. Please try again.',
              onRetry: async () => {
                gate.retry();
              },
            }}
          />
        </ThemedView>
      </>
    );
  }

  if (gate.isResolving) {
    return (
      <>
        <SEO title="Settings - Syra" description="App settings and preferences" />
        <ThemedView className="flex-1 items-center justify-center px-12">
          <Text className="text-base text-center text-muted-foreground">
            Loading account settings
          </Text>
        </ThemedView>
      </>
    );
  }

  if (!gate.isAuthenticated) {
    return (
      <>
        <SEO title="Settings - Syra" description="App settings and preferences" />
        <ThemedView className="flex-1 items-center justify-center px-12">
          <Text className="text-base text-center text-muted-foreground">
            Please log in to access settings
          </Text>
        </ThemedView>
      </>
    );
  }

  return (
    <>
      <SEO title="Settings - Syra" description="App settings and preferences" />
      <ThemedView className="flex-1">
        <ScrollView
          className="flex-1"
          contentContainerStyle={styles.scrollContent}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.contentColumn}>
            <View style={styles.pageHeader}>
              <Text className="text-3xl font-bold text-foreground" numberOfLines={1}>
                Settings
              </Text>
            </View>

            <View style={styles.accountHeader}>
              <Avatar source={user?.avatar ?? undefined} variant="thumb" size={80} />
              <Text className="text-2xl font-bold text-foreground mt-2 text-center" numberOfLines={1}>
                {userName}
              </Text>
              <Text className="text-base text-muted-foreground text-center" numberOfLines={1}>
                {usernameLabel}
              </Text>
            </View>

            <SettingsListGroup title="Account & profile">
              <SettingsListItem
                icon={<RowIcon name="person-outline" />}
                title="View profile"
                description="Open your public Syra profile"
                onPress={handleViewProfile}
                disabled={!user?.username}
              />
              <SettingsListItem
                icon={<RowIcon name="person-circle-outline" />}
                title="Manage account"
                description="Oxy account, identity and security"
                onPress={handleManageAccount}
              />
            </SettingsListGroup>

            <SettingsListGroup title="Create">
              <SettingsListItem
                icon={<RowIcon name="mic-outline" />}
                title="Syra Studio"
                description="Upload music, manage podcasts and your artist profile"
                onPress={handleOpenStudio}
              />
            </SettingsListGroup>

            <SettingsListGroup title="Preferences">
              <SettingsControlBlock
                icon="phone-portrait-outline"
                title="Color mode"
                description="Choose how Syra follows your device theme"
              >
                <SegmentedControl<'system' | 'light' | 'dark'>
                  label="Color mode"
                  type="radio"
                  size="small"
                  value={themeMode}
                  onChange={handleThemeModeChange}
                >
                  <SegmentedControlItem value="system">
                    <SegmentedControlItemText numberOfLines={1}>System</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="light">
                    <SegmentedControlItemText numberOfLines={1}>Light</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="dark">
                    <SegmentedControlItemText numberOfLines={1}>Dark</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="color-palette-outline"
                title="Accent color"
                description="Applies to controls and highlighted surfaces"
              >
                <ColorSwatchPicker value={colorPreset} onChange={handleColorChange} />
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="language-outline"
                title="Language"
                description="App display language"
              >
                <SegmentedControl<string>
                  label="Language"
                  type="radio"
                  size="small"
                  value={i18n.language || 'en-US'}
                  onChange={handleLanguageChange}
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SegmentedControlItem key={option.value} value={option.value}>
                      <SegmentedControlItemText numberOfLines={1}>
                        {option.label}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </SettingsControlBlock>
            </SettingsListGroup>

            <SettingsListGroup title="Playback">
              <SettingsListItem
                icon={<RowIcon name="play-circle-outline" />}
                title="Autoplay"
                description="Automatically play similar songs when your music ends"
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.autoplay ?? true}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ autoplay: value })}
                  />
                }
              />
              <SettingsListItem
                icon={<RowIcon name="albums-outline" />}
                title="Gapless playback"
                description="Play songs without gaps between tracks"
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.gaplessPlayback ?? true}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ gaplessPlayback: value })}
                  />
                }
              />
              <SettingsListItem
                icon={<RowIcon name="volume-medium-outline" />}
                title="Normalize volume"
                description="Set the same volume level for all tracks"
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.normalizeVolume ?? true}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ normalizeVolume: value })}
                  />
                }
              />
              <SettingsListItem
                icon={<RowIcon name="alert-circle-outline" />}
                title="Explicit content"
                description="Allow playback of explicit content"
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.explicitContent ?? true}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ explicitContent: value })}
                  />
                }
              />
              <SettingsControlBlock
                icon="options-outline"
                title="Crossfade"
                description="Overlap songs when switching tracks"
              >
                <Slider
                  value={musicPreferences?.crossfade ?? 0}
                  onValueChange={(value) => handleMusicPreferenceUpdate({ crossfade: value })}
                  minimumValue={0}
                  maximumValue={12}
                  step={1}
                  formatValue={(value) => (value === 0 ? 'Off' : `${value}s`)}
                />
              </SettingsControlBlock>
            </SettingsListGroup>

            <SettingsListGroup title="Audio quality & data">
              <SettingsControlBlock
                icon="wifi-outline"
                title="Streaming quality"
                description="Higher quality uses more data"
              >
                <SegmentedControl<AudioQuality>
                  label="Streaming quality"
                  type="radio"
                  size="small"
                  value={musicPreferences?.audioQuality ?? 'normal'}
                  onChange={(value) => handleMusicPreferenceUpdate({ audioQuality: value })}
                >
                  <SegmentedControlItem value="low">
                    <SegmentedControlItemText numberOfLines={1}>Low</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="normal">
                    <SegmentedControlItemText numberOfLines={1}>Normal</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="high">
                    <SegmentedControlItemText numberOfLines={1}>High</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="very_high">
                    <SegmentedControlItemText numberOfLines={1}>Very high</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="cloud-download-outline"
                title="Download quality"
                description="Quality for downloaded music"
              >
                <SegmentedControl<AudioQuality>
                  label="Download quality"
                  type="radio"
                  size="small"
                  value={musicPreferences?.downloadQuality ?? 'normal'}
                  onChange={(value) => handleMusicPreferenceUpdate({ downloadQuality: value })}
                >
                  <SegmentedControlItem value="low">
                    <SegmentedControlItemText numberOfLines={1}>Low</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="normal">
                    <SegmentedControlItemText numberOfLines={1}>Normal</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="high">
                    <SegmentedControlItemText numberOfLines={1}>High</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="very_high">
                    <SegmentedControlItemText numberOfLines={1}>Very high</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsListItem
                icon={<RowIcon name="radio-outline" />}
                title="Data saver"
                description="Use less data while streaming music"
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.dataSaver ?? false}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ dataSaver: value })}
                  />
                }
              />
            </SettingsListGroup>

            <SettingsListGroup title="Privacy & data">
              {privacySettings ? (
                <SettingsControlBlock
                  icon="lock-closed-outline"
                  title="Profile visibility"
                  description="Choose who can see your profile"
                >
                  <SegmentedControl<ProfileVisibility>
                    label="Profile visibility"
                    type="radio"
                    size="small"
                    value={privacySettings.profileVisibility ?? 'public'}
                    onChange={(value) => handlePrivacyUpdate({ profileVisibility: value })}
                  >
                    <SegmentedControlItem value="public">
                      <SegmentedControlItemText numberOfLines={1}>Public</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="followers_only">
                      <SegmentedControlItemText numberOfLines={1}>Followers</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="private">
                      <SegmentedControlItemText numberOfLines={1}>Private</SegmentedControlItemText>
                    </SegmentedControlItem>
                  </SegmentedControl>
                </SettingsControlBlock>
              ) : null}
              {privacySettings ? (
                <SettingsListItem
                  icon={<RowIcon name="card-outline" />}
                  title="Show contact info"
                  description="Display your contact information on your profile"
                  showChevron={false}
                  rightElement={
                    <Switch
                      value={privacySettings.showContactInfo ?? true}
                      onValueChange={(value) => handlePrivacyUpdate({ showContactInfo: value })}
                    />
                  }
                />
              ) : null}
              {privacySettings ? (
                <SettingsListItem
                  icon={<RowIcon name="ellipse-outline" />}
                  title="Show online status"
                  description="Let others see when you're online"
                  showChevron={false}
                  rightElement={
                    <Switch
                      value={privacySettings.showOnlineStatus ?? true}
                      onValueChange={(value) => handlePrivacyUpdate({ showOnlineStatus: value })}
                    />
                  }
                />
              ) : null}
              <SettingsListItem
                icon={<RowIcon name="trash-outline" />}
                title="Clear cache"
                description="Free up space by clearing cached data"
                onPress={handleClearCache}
                showChevron={false}
              />
            </SettingsListGroup>

            <SettingsListGroup title="About & support">
              <SettingsListItem
                icon={<RowIcon name="information-circle-outline" />}
                title="Version"
                value={`Syra ${appVersion}`}
                showChevron={false}
              />
              <SettingsListItem
                icon={<RowIcon name="document-text-outline" />}
                title="Terms of Service"
                onPress={() => Alert.alert('Terms of Service', 'Terms of service page coming soon.')}
              />
              <SettingsListItem
                icon={<RowIcon name="shield-checkmark-outline" />}
                title="Privacy Policy"
                onPress={() => Alert.alert('Privacy Policy', 'Privacy policy page coming soon.')}
              />
              <SettingsListItem
                icon={<RowIcon name="help-circle-outline" />}
                title="Help & Support"
                onPress={() => Alert.alert('Help & Support', 'Help center coming soon.')}
              />
              <SettingsListItem
                icon={<RowIcon name="flag-outline" />}
                title="Report a copyright violation"
                description="Tell us about content that infringes your rights"
                onPress={() => router.push('/copyright/report')}
              />
            </SettingsListGroup>

            <SettingsListGroup>
              <SettingsListItem
                icon={<RowIcon name="log-out-outline" destructive />}
                title="Log out"
                onPress={handleLogout}
                destructive
                showChevron={false}
              />
            </SettingsListGroup>
          </View>
        </ScrollView>
      </ThemedView>
    </>
  );
};

const styles = StyleSheet.create({
  // The auth-gate error fills the screen but keeps `ThemedView`'s background.
  gateState: {
    backgroundColor: 'transparent',
  },
  scrollContent: {
    alignItems: 'center',
    paddingTop: 16,
    paddingBottom: 40,
  },
  contentColumn: {
    width: '100%',
    maxWidth: 680,
  },
  pageHeader: {
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  accountHeader: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 20,
  },
  controlBlock: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  controlHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minWidth: 0,
  },
  controlText: {
    flex: 1,
    minWidth: 0,
  },
  controlContent: {
    alignSelf: 'stretch',
  },
});

export default SettingsScreen;
