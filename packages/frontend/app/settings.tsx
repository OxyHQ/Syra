import React from 'react';
import { StyleSheet, View, Text, ScrollView, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import {
  SettingsSection,
  SettingsItem,
  SettingsToggle,
  SettingsSlider,
  SettingsPicker,
} from '@/components/settings';
import { useMusicPreferences } from '@/hooks/useMusicPreferences';
import { useCurrentUserPrivacySettings, updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';
import { useAppearanceStore } from '@/store/appearanceStore';
import { authenticatedClient } from '@/utils/api';
import { confirmDialog } from '@/utils/alerts';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import i18n from '@/lib/i18n';
import { STORAGE_KEYS } from '@/lib/constants';
import { Storage } from '@/utils/storage';

/**
 * Syra Settings Screen
 * Comprehensive settings screen with all sections like Spotify
 */
const SettingsScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { user, isAuthenticated, logout, oxyServices } = useOxy();
  const { preferences: musicPreferences, updatePreferences: updateMusicPreferences } = useMusicPreferences();
  const privacySettings = useCurrentUserPrivacySettings();
  const appearanceSettings = useAppearanceStore((state) => state.mySettings);
  const updateAppearanceSettings = useAppearanceStore((state) => state.updateMySettings);

  const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;
  const appVersion = Constants.expoConfig?.version || '2.0.0';
  const currentLanguage = i18n.language || 'en-US';

  // Handle user name (can be object or string)
  const userName = user?.name
    ? typeof user.name === 'string'
      ? user.name
      : (user.name as any)?.full || 
        ((user.name as any)?.first 
          ? `${(user.name as any).first} ${(user.name as any).last || ''}`.trim()
          : '')
    : user?.username || 'User';

  // Handle language change
  const handleLanguageChange = async (language: string) => {
    try {
      await i18n.changeLanguage(language);
      await Storage.set(STORAGE_KEYS.LANGUAGE_PREFERENCE, language);
    } catch (error) {
      console.error('Failed to change language:', error);
      Alert.alert('Error', 'Failed to change language. Please try again.');
    }
  };

  const languageOptions = [
    { label: 'English (US)', value: 'en-US' },
    { label: 'Español (ES)', value: 'es-ES' },
    { label: 'Italiano (IT)', value: 'it-IT' },
  ];

  // Handle logout
  const handleLogout = async () => {
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
  };

  // Handle clear cache
  const handleClearCache = async () => {
    const confirmed = await confirmDialog({
      title: 'Clear Cache',
      message: 'This will clear all cached data. You may need to reload some content.',
      okText: 'Clear',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      // Clear AsyncStorage cache (except important data like auth tokens)
      const keys = await AsyncStorage.getAllKeys();
      const keysToClear = keys.filter(key => 
        key.includes('cache') || 
        key.includes('_cache') ||
        key.startsWith('@syra') ||
        key.startsWith('@musico') ||
        key.startsWith('oxy_appearance_settings') ||
        key.startsWith('syra_music_preferences') ||
        key.startsWith('musico_music_preferences')
      );
      await Promise.all(keysToClear.map(key => AsyncStorage.removeItem(key)));
      Alert.alert('Success', 'Cache cleared successfully.');
    } catch (error) {
      console.error('Clear cache failed:', error);
      Alert.alert('Error', 'Failed to clear cache. Please try again.');
    }
  };

  // Update privacy settings
  const handlePrivacyUpdate = async (updates: Partial<typeof privacySettings>) => {
    try {
      const newSettings = { ...privacySettings, ...updates } as typeof privacySettings;
      await authenticatedClient.put('/profile/settings', { privacy: newSettings });
      await updatePrivacySettingsCache(newSettings);
      // Trigger reload by updating a state variable or using a refresh function
    } catch (error) {
      console.error('Failed to update privacy settings:', error);
      Alert.alert('Error', 'Failed to update privacy settings.');
    }
  };

  if (!isAuthenticated) {
    return (
      <>
        <SEO title="Settings - Syra" description="App settings and preferences" />
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
          <Text style={[styles.notAuthenticated, { color: theme.colors.text }]}>
            Please log in to access settings
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <SEO title="Settings - Syra" description="App settings and preferences" />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Settings</Text>
        </View>

        {/* Profile Section */}
        <SettingsSection title="Profile">
          <View style={[styles.profileHeader, { borderBottomColor: theme.colors.border }]}>
            <Avatar
              source={{ uri: avatarUri }}
              size={64}
            />
            <View style={styles.profileInfo}>
              <Text style={[styles.profileName, { color: theme.colors.text }]}>
                {userName}
              </Text>
              <Text style={[styles.profileEmail, { color: theme.colors.textSecondary }]}>
                {user?.email || ''}
              </Text>
            </View>
          </View>
          <SettingsItem
            label="View Profile"
            onPress={() => {
              // Navigate to profile
              if (user?.username) {
                router.push(`/u/${user.username}`);
              }
            }}
            showChevron
          />
        </SettingsSection>

        {/* Playback Section */}
        <SettingsSection title="Playback">
          <SettingsToggle
            label="Autoplay"
            description="Automatically play similar songs when your music ends"
            value={musicPreferences?.autoplay ?? true}
            onValueChange={(value) => updateMusicPreferences({ autoplay: value })}
          />
          <SettingsSlider
            label="Crossfade"
            description="Overlap songs when switching tracks"
            value={musicPreferences?.crossfade ?? 0}
            onValueChange={(value) => updateMusicPreferences({ crossfade: value })}
            minimumValue={0}
            maximumValue={12}
            step={1}
            formatValue={(value) => value === 0 ? 'Off' : `${value}s`}
          />
          <SettingsToggle
            label="Gapless Playback"
            description="Play songs without gaps between tracks"
            value={musicPreferences?.gaplessPlayback ?? true}
            onValueChange={(value) => updateMusicPreferences({ gaplessPlayback: value })}
          />
          <SettingsToggle
            label="Normalize Volume"
            description="Set the same volume level for all tracks"
            value={musicPreferences?.normalizeVolume ?? true}
            onValueChange={(value) => updateMusicPreferences({ normalizeVolume: value })}
          />
          <SettingsToggle
            label="Explicit Content"
            description="Allow playback of explicit content"
            value={musicPreferences?.explicitContent ?? true}
            onValueChange={(value) => updateMusicPreferences({ explicitContent: value })}
          />
        </SettingsSection>

        {/* Audio Quality Section */}
        <SettingsSection title="Audio Quality">
          <SettingsPicker
            label="Streaming Quality"
            description="Higher quality uses more data"
            value={musicPreferences?.streamingQuality || 'normal'}
            options={[
              { label: 'Normal (96 kbps)', value: 'normal' },
              { label: 'High (160 kbps)', value: 'high' },
              { label: 'Very High (320 kbps)', value: 'very_high' },
            ]}
            onValueChange={(value) => updateMusicPreferences({ streamingQuality: value })}
          />
          <SettingsPicker
            label="Download Quality"
            description="Quality for downloaded music"
            value={musicPreferences?.downloadQuality || 'normal'}
            options={[
              { label: 'Normal (96 kbps)', value: 'normal' },
              { label: 'High (160 kbps)', value: 'high' },
              { label: 'Very High (320 kbps)', value: 'very_high' },
            ]}
            onValueChange={(value) => updateMusicPreferences({ downloadQuality: value })}
          />
          <SettingsToggle
            label="WiFi Only Downloads"
            description="Only download music when connected to WiFi"
            value={musicPreferences?.wifiOnlyDownloads ?? false}
            onValueChange={(value) => updateMusicPreferences({ wifiOnlyDownloads: value })}
          />
        </SettingsSection>

        {/* Privacy Section */}
        {privacySettings && (
          <SettingsSection title="Privacy">
            <SettingsPicker
              label="Profile Visibility"
              description="Who can see your profile"
              value={privacySettings.profileVisibility || 'public'}
              options={[
                { label: 'Public', value: 'public' },
                { label: 'Private', value: 'private' },
                { label: 'Followers Only', value: 'followers_only' },
              ]}
              onValueChange={(value) => handlePrivacyUpdate({ profileVisibility: value })}
            />
            <SettingsToggle
              label="Show Contact Info"
              description="Display your contact information on your profile"
              value={privacySettings.showContactInfo ?? true}
              onValueChange={(value) => handlePrivacyUpdate({ showContactInfo: value })}
            />
            <SettingsToggle
              label="Show Online Status"
              description="Let others see when you're online"
              value={privacySettings.showOnlineStatus ?? true}
              onValueChange={(value) => handlePrivacyUpdate({ showOnlineStatus: value })}
            />
          </SettingsSection>
        )}

        {/* Display Section */}
        <SettingsSection title="Display">
          <SettingsPicker
            label="Theme"
            description="Choose your preferred theme"
            value={appearanceSettings?.appearance?.themeMode || 'system'}
            options={[
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
              { label: 'System', value: 'system', description: 'Match system theme' },
            ]}
            onValueChange={(value) => {
              updateAppearanceSettings({
                appearance: { ...appearanceSettings?.appearance, themeMode: value },
              });
            }}
          />
        </SettingsSection>

        {/* Language Section */}
        <SettingsSection title="Language & Region">
          <SettingsPicker
            label="Language"
            description="Choose your preferred language"
            value={currentLanguage}
            options={languageOptions}
            onValueChange={handleLanguageChange}
          />
          <SettingsItem
            label="Region"
            description="United States"
            onPress={() => {
              Alert.alert('Region', 'Region selection coming soon.');
            }}
            showChevron
          />
        </SettingsSection>

        {/* Notifications Section */}
        <SettingsSection title="Notifications">
          <SettingsToggle
            label="Email Notifications"
            description="Receive notifications via email"
            value={true}
            onValueChange={() => {
              // Placeholder - implement notification settings
              Alert.alert('Coming Soon', 'Email notification settings will be available soon.');
            }}
          />
          <SettingsToggle
            label="Push Notifications"
            description="Receive push notifications on your device"
            value={true}
            onValueChange={() => {
              // Placeholder - implement notification settings
              Alert.alert('Coming Soon', 'Push notification settings will be available soon.');
            }}
          />
        </SettingsSection>

        {/* Storage Section */}
        <SettingsSection title="Storage">
          <SettingsItem
            label="Clear Cache"
            description="Free up space by clearing cached data"
            onPress={handleClearCache}
            showChevron
          />
          <SettingsItem
            label="Storage Usage"
            description="View how much space is being used"
            onPress={() => {
              Alert.alert('Storage', 'Storage usage information coming soon.');
            }}
            showChevron
          />
        </SettingsSection>

        {/* About Section */}
        <SettingsSection title="About">
          <SettingsItem
            label="Version"
            description={`Syra ${appVersion}`}
            disabled
          />
          <SettingsItem
            label="Terms of Service"
            description="Read our terms of service"
            onPress={() => {
              // Open terms of service
              Alert.alert('Terms of Service', 'Terms of service page coming soon.');
            }}
            showChevron
          />
          <SettingsItem
            label="Privacy Policy"
            description="Read our privacy policy"
            onPress={() => {
              // Open privacy policy
              Alert.alert('Privacy Policy', 'Privacy policy page coming soon.');
            }}
            showChevron
          />
          <SettingsItem
            label="Help & Support"
            description="Get help with Syra"
            onPress={() => {
              Alert.alert('Help & Support', 'Help center coming soon.');
            }}
            showChevron
          />
          <SettingsItem
            label="Log Out"
            description="Sign out of your account"
            onPress={handleLogout}
            rightElement={
              <MaterialCommunityIcons
                name="logout"
                size={20}
                color={theme.colors.error || '#FF0000'}
              />
            }
          />
        </SettingsSection>

        <View style={{ height: 100 }} />
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 18,
    paddingBottom: 100,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  notAuthenticated: {
    fontSize: 16,
    textAlign: 'center',
    padding: 48,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 16,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 14,
  },
});

export default SettingsScreen;

