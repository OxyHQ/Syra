import React, { useCallback } from 'react';
import { View, Text, ScrollView, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy } from '@oxyhq/services';
import { getAccountDisplayName } from '@oxyhq/core';
import { useRouter } from 'expo-router';
import {
  SettingsListGroup,
  SettingsListItem,
  SettingsListDivider,
} from '@oxyhq/bloom/settings-list';
import { Switch } from '@oxyhq/bloom/switch';
import * as SegmentedControl from '@oxyhq/bloom/segmented-control';
import {
  APP_COLOR_PRESETS,
  useBloomTheme,
  type AppColorName,
} from '@oxyhq/bloom/theme';
import Constants from 'expo-constants';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { ThemedView } from '@/components/ThemedView';
import { RowIcon } from '@/components/settings/RowIcon';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { Slider } from '@/components/Slider';
import { useMusicPreferences } from '@/hooks/useMusicPreferences';
import {
  useCurrentUserPrivacySettings,
  updatePrivacySettingsCache,
  type PrivacySettings,
} from '@/hooks/usePrivacySettings';
import { useAppearanceStore } from '@/store/appearanceStore';
import { authenticatedClient } from '@/utils/api';
import { confirmDialog } from '@/utils/alerts';
import i18n from '@/lib/i18n';
import { STORAGE_KEYS } from '@/lib/constants';
import { Storage } from '@/utils/storage';

type AudioQuality = 'normal' | 'high' | 'very_high';
type ProfileVisibility = 'public' | 'private' | 'followers_only';

const LANGUAGE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'English', value: 'en-US' },
  { label: 'Español', value: 'es-ES' },
  { label: 'Italiano', value: 'it-IT' },
];

interface SettingsControlSectionProps {
  /** Optional leading icon name; when present the heading renders as a row. */
  icon?: React.ComponentProps<typeof RowIcon>['name'];
  title: string;
  /** Optional sub-heading caption. */
  caption?: string;
  children: React.ReactNode;
}

/**
 * Padded section wrapping a heading (plain or icon + label) and an optional
 * caption above a control (e.g. a `SegmentedControl`). Icon sections use the
 * slightly larger `gap-3`; plain/captioned sections use `gap-2`.
 */
const SettingsControlSection: React.FC<SettingsControlSectionProps> = ({
  icon,
  title,
  caption,
  children,
}) => (
  <View className={icon ? 'px-5 py-3 gap-3' : 'px-5 py-3 gap-2'}>
    {icon ? (
      <View className="flex-row items-center gap-3">
        <RowIcon name={icon} />
        <Text className="text-[16px] text-foreground">{title}</Text>
      </View>
    ) : (
      <Text className="text-[16px] text-foreground">{title}</Text>
    )}
    {caption ? <Text className="text-xs text-muted-foreground">{caption}</Text> : null}
    {children}
  </View>
);

/**
 * Syra Settings Screen — grouped Bloom sections mirroring the Mention app.
 * Account, playback, audio quality, privacy, appearance, language, storage,
 * about and sign-out, rendered with Bloom's settings-list primitives.
 */
const SettingsScreen: React.FC = () => {
  const router = useRouter();
  const { user, isAuthenticated, logout, oxyServices } = useOxy();
  const { preferences: musicPreferences, updatePreferences: updateMusicPreferences } = useMusicPreferences();
  const privacySettings = useCurrentUserPrivacySettings();
  const appearanceSettings = useAppearanceStore((state) => state.mySettings);
  const updateAppearanceSettings = useAppearanceStore((state) => state.updateMySettings);
  const { colorPreset, mode: bloomMode, setMode, setColorPreset } = useBloomTheme();

  const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb') : undefined;
  const appVersion = Constants.expoConfig?.version ?? '2.0.0';
  const userName = getAccountDisplayName(user);

  const themeMode: 'system' | 'light' | 'dark' =
    bloomMode === 'light' || bloomMode === 'dark' ? bloomMode : 'system';

  const handleLanguageChange = useCallback(async (language: string) => {
    try {
      await i18n.changeLanguage(language);
      await Storage.set(STORAGE_KEYS.LANGUAGE_PREFERENCE, language);
    } catch (error) {
      console.error('Failed to change language:', error);
      Alert.alert('Error', 'Failed to change language. Please try again.');
    }
  }, []);

  const handleThemeModeChange = useCallback((mode: 'system' | 'light' | 'dark') => {
    setMode(mode);
    void updateAppearanceSettings({
      appearance: {
        themeMode: mode,
        primaryColor: appearanceSettings?.appearance?.primaryColor,
      },
    });
  }, [setMode, updateAppearanceSettings, appearanceSettings?.appearance?.primaryColor]);

  const handleColorChange = useCallback((name: AppColorName) => {
    setColorPreset(name);
    void updateAppearanceSettings({
      appearance: {
        themeMode: appearanceSettings?.appearance?.themeMode ?? 'system',
        primaryColor: APP_COLOR_PRESETS[name].hex,
      },
    });
  }, [setColorPreset, updateAppearanceSettings, appearanceSettings?.appearance?.themeMode]);

  const handlePrivacyUpdate = useCallback(async (updates: Partial<PrivacySettings>) => {
    try {
      const newSettings: PrivacySettings = { ...privacySettings, ...updates };
      await authenticatedClient.put('/profile/settings', { privacy: newSettings });
      await updatePrivacySettingsCache(newSettings);
    } catch (error) {
      console.error('Failed to update privacy settings:', error);
      Alert.alert('Error', 'Failed to update privacy settings.');
    }
  }, [privacySettings]);

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
      console.error('Logout failed:', error);
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
      console.error('Clear cache failed:', error);
      Alert.alert('Error', 'Failed to clear cache. Please try again.');
    }
  }, []);

  if (!isAuthenticated) {
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
          contentContainerClassName="py-4"
          showsVerticalScrollIndicator={false}
        >
          {/* Account header */}
          <View className="items-center py-4 gap-1">
            <Avatar source={avatarUri ? { uri: avatarUri } : undefined} size={80} />
            <Text className="text-2xl font-bold text-foreground mt-2" numberOfLines={1}>
              {userName}
            </Text>
            <Text className="text-base text-muted-foreground" numberOfLines={1}>
              @{user?.username ?? 'username'}
            </Text>
          </View>

          <SettingsListGroup>
            <SettingsListItem
              icon={<RowIcon name="person-outline" />}
              title="View profile"
              description="See your public profile"
              onPress={() => {
                if (user?.username) {
                  router.push(`/u/${user.username}`);
                }
              }}
            />
          </SettingsListGroup>

          {/* Playback */}
          <SettingsListGroup title="Playback">
            <SettingsListItem
              icon={<RowIcon name="play-circle-outline" />}
              title="Autoplay"
              description="Automatically play similar songs when your music ends"
              showChevron={false}
              rightElement={
                <Switch
                  value={musicPreferences?.autoplay ?? true}
                  onValueChange={(value) => updateMusicPreferences({ autoplay: value })}
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
                  onValueChange={(value) => updateMusicPreferences({ gaplessPlayback: value })}
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
                  onValueChange={(value) => updateMusicPreferences({ normalizeVolume: value })}
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
                  onValueChange={(value) => updateMusicPreferences({ explicitContent: value })}
                />
              }
            />
          </SettingsListGroup>

          <View className="px-5 py-3">
            <Slider
              value={musicPreferences?.crossfade ?? 0}
              onValueChange={(value) => updateMusicPreferences({ crossfade: value })}
              minimumValue={0}
              maximumValue={12}
              step={1}
              label="Crossfade"
              formatValue={(value) => (value === 0 ? 'Off' : `${value}s`)}
            />
            <Text className="text-xs mt-1 text-muted-foreground">
              Overlap songs when switching tracks
            </Text>
          </View>

          {/* Audio quality */}
          <SettingsControlSection title="Streaming quality" caption="Higher quality uses more data">
            <SegmentedControl.Root<AudioQuality>
              label="Streaming quality"
              type="radio"
              value={musicPreferences?.streamingQuality ?? 'normal'}
              onChange={(value) => updateMusicPreferences({ streamingQuality: value })}
            >
              <SegmentedControl.Item value="normal">
                <SegmentedControl.ItemText>Normal</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="high">
                <SegmentedControl.ItemText>High</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="very_high">
                <SegmentedControl.ItemText>Very high</SegmentedControl.ItemText>
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </SettingsControlSection>

          <SettingsListDivider />

          <SettingsControlSection title="Download quality" caption="Quality for downloaded music">
            <SegmentedControl.Root<AudioQuality>
              label="Download quality"
              type="radio"
              value={musicPreferences?.downloadQuality ?? 'normal'}
              onChange={(value) => updateMusicPreferences({ downloadQuality: value })}
            >
              <SegmentedControl.Item value="normal">
                <SegmentedControl.ItemText>Normal</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="high">
                <SegmentedControl.ItemText>High</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="very_high">
                <SegmentedControl.ItemText>Very high</SegmentedControl.ItemText>
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </SettingsControlSection>

          <SettingsListGroup>
            <SettingsListItem
              icon={<RowIcon name="wifi-outline" />}
              title="WiFi-only downloads"
              description="Only download music when connected to WiFi"
              showChevron={false}
              rightElement={
                <Switch
                  value={musicPreferences?.wifiOnlyDownloads ?? false}
                  onValueChange={(value) => updateMusicPreferences({ wifiOnlyDownloads: value })}
                />
              }
            />
          </SettingsListGroup>

          {/* Privacy */}
          {privacySettings && (
            <>
              <SettingsControlSection
                title="Profile visibility"
                caption="Who can see your profile"
              >
                <SegmentedControl.Root<ProfileVisibility>
                  label="Profile visibility"
                  type="radio"
                  value={privacySettings.profileVisibility ?? 'public'}
                  onChange={(value) => handlePrivacyUpdate({ profileVisibility: value })}
                >
                  <SegmentedControl.Item value="public">
                    <SegmentedControl.ItemText>Public</SegmentedControl.ItemText>
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="followers_only">
                    <SegmentedControl.ItemText>Followers</SegmentedControl.ItemText>
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="private">
                    <SegmentedControl.ItemText>Private</SegmentedControl.ItemText>
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </SettingsControlSection>

              <SettingsListGroup>
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
              </SettingsListGroup>
            </>
          )}

          {/* Appearance */}
          <SettingsControlSection icon="phone-portrait-outline" title="Color mode">
            <SegmentedControl.Root<'system' | 'light' | 'dark'>
              label="Color mode"
              type="radio"
              value={themeMode}
              onChange={handleThemeModeChange}
            >
              <SegmentedControl.Item value="system">
                <SegmentedControl.ItemText>System</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="light">
                <SegmentedControl.ItemText>Light</SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item value="dark">
                <SegmentedControl.ItemText>Dark</SegmentedControl.ItemText>
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </SettingsControlSection>

          <SettingsListDivider />

          <View className="px-5 py-3 gap-3">
            <View className="flex-row items-center gap-3">
              <RowIcon name="color-palette-outline" />
              <Text className="text-[16px] text-foreground">Accent color</Text>
            </View>
            <ColorSwatchPicker value={colorPreset} onChange={handleColorChange} />
          </View>

          {/* Language */}
          <SettingsControlSection icon="language-outline" title="Language">
            <SegmentedControl.Root<string>
              label="Language"
              type="radio"
              value={i18n.language || 'en-US'}
              onChange={handleLanguageChange}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <SegmentedControl.Item key={option.value} value={option.value}>
                  <SegmentedControl.ItemText>{option.label}</SegmentedControl.ItemText>
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </SettingsControlSection>

          {/* Storage */}
          <SettingsListGroup title="Storage">
            <SettingsListItem
              icon={<RowIcon name="trash-outline" />}
              title="Clear cache"
              description="Free up space by clearing cached data"
              onPress={handleClearCache}
            />
          </SettingsListGroup>

          {/* About */}
          <SettingsListGroup title="About">
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
          </SettingsListGroup>

          {/* Sign out */}
          <SettingsListGroup>
            <SettingsListItem
              icon={<RowIcon name="log-out-outline" destructive />}
              title="Log out"
              onPress={handleLogout}
              destructive
              showChevron={false}
            />
          </SettingsListGroup>

          <View className="h-24" />
        </ScrollView>
      </ThemedView>
    </>
  );
};

export default SettingsScreen;
