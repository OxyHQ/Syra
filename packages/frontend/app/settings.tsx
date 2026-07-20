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
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { confirmDialog } from '@/utils/alerts';
import { createScopedLogger } from '@/utils/logger';
import { Storage } from '@/utils/storage';

type AudioQuality = 'low' | 'normal' | 'high' | 'very_high';
type ProfileVisibility = 'public' | 'private' | 'followers_only';

type RowIconName = React.ComponentProps<typeof RowIcon>['name'];

const logger = createScopedLogger('SettingsScreen');

const STUDIO_URL = 'https://studio.syra.fm';

// Endonyms, deliberately NOT run through `t()`. Someone hunting for Italian
// should read "Italiano" whatever the current language is — translating these
// would hide each option from the only people looking for it.
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
  const { t } = useTranslation();
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
      Alert.alert(t('common.error'), t('settings.alerts.languageError'));
    }
  }, []);

  const requirePrivateSession = useCallback((): boolean => {
    if (canUsePrivateApi) return true;
    openAccountDialog('signin');
    Alert.alert(t('settings.alerts.signInRequired.title'), t('settings.alerts.signInRequired.message'));
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
      Alert.alert(t('common.error'), t('settings.alerts.privacyError'));
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
      Alert.alert(t('common.error'), t('settings.alerts.logoutError'));
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
      Alert.alert(t('common.success'), t('settings.alerts.cacheCleared'));
    } catch (error) {
      logger.error('Clear cache failed', { error });
      Alert.alert(t('common.error'), t('settings.alerts.clearCacheError'));
    }
  }, []);

  // Terminal auth failure — the session never resolved within the gate's bound.
  if (gate.isTimedOut) {
    return (
      <>
        <SEO title={t('settings.seo.title')} description={t('settings.seo.description')} />
        <ThemedView className="flex-1">
          <EmptyState
            containerStyle={styles.gateState}
            icon={{ name: 'cloud-offline-outline' }}
            error={{
              title: t('settings.gate.unavailableTitle'),
              message: t('settings.gate.unavailableMessage'),
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
        <SEO title={t('settings.seo.title')} description={t('settings.seo.description')} />
        <ThemedView className="flex-1 items-center justify-center px-12">
          <Text className="text-base text-center text-muted-foreground">
            {t('settings.gate.loading')}
          </Text>
        </ThemedView>
      </>
    );
  }

  if (!gate.isAuthenticated) {
    return (
      <>
        <SEO title={t('settings.seo.title')} description={t('settings.seo.description')} />
        <ThemedView className="flex-1 items-center justify-center px-12">
          <Text className="text-base text-center text-muted-foreground">
            {t('settings.gate.signInRequired')}
          </Text>
        </ThemedView>
      </>
    );
  }

  return (
    <>
      <SEO title={t('settings.seo.title')} description={t('settings.seo.description')} />
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
                {t('settings.title')}
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

            <SettingsListGroup title={t('settings.groups.account')}>
              <SettingsListItem
                icon={<RowIcon name="person-outline" />}
                title={t('settings.account.viewProfile')}
                description={t('settings.account.viewProfileHint')}
                onPress={handleViewProfile}
                disabled={!user?.username}
              />
              <SettingsListItem
                icon={<RowIcon name="person-circle-outline" />}
                title={t('settings.account.manage')}
                description={t('settings.account.manageHint')}
                onPress={handleManageAccount}
              />
            </SettingsListGroup>

            <SettingsListGroup title={t('settings.groups.create')}>
              <SettingsListItem
                icon={<RowIcon name="mic-outline" />}
                title={t('settings.create.studio')}
                description={t('settings.create.studioHint')}
                onPress={handleOpenStudio}
              />
            </SettingsListGroup>

            <SettingsListGroup title={t('settings.groups.preferences')}>
              <SettingsControlBlock
                icon="phone-portrait-outline"
                title={t('settings.preferences.colorMode')}
                description={t('settings.preferences.colorModeHint')}
              >
                <SegmentedControl<'system' | 'light' | 'dark'>
                  label={t('settings.preferences.colorMode')}
                  type="radio"
                  size="small"
                  value={themeMode}
                  onChange={handleThemeModeChange}
                >
                  <SegmentedControlItem value="system">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.system')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="light">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.light')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="dark">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.dark')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="color-palette-outline"
                title={t('settings.preferences.accentColor')}
                description={t('settings.preferences.accentColorHint')}
              >
                <ColorSwatchPicker value={colorPreset} onChange={handleColorChange} />
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="language-outline"
                title={t('settings.preferences.language')}
                description={t('settings.preferences.languageHint')}
              >
                <SegmentedControl<string>
                  label={t('settings.preferences.language')}
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

            <SettingsListGroup title={t('settings.groups.playback')}>
              <SettingsListItem
                icon={<RowIcon name="play-circle-outline" />}
                title={t('settings.playback.autoplay')}
                description={t('settings.playback.autoplayHint')}
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
                title={t('settings.playback.gapless')}
                description={t('settings.playback.gaplessHint')}
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
                title={t('settings.playback.normalizeVolume')}
                description={t('settings.playback.normalizeVolumeHint')}
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
                title={t('settings.playback.explicit')}
                description={t('settings.playback.explicitHint')}
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
                title={t('settings.playback.crossfade')}
                description={t('settings.playback.crossfadeHint')}
              >
                <Slider
                  value={musicPreferences?.crossfade ?? 0}
                  onValueChange={(value) => handleMusicPreferenceUpdate({ crossfade: value })}
                  minimumValue={0}
                  maximumValue={12}
                  step={1}
                  formatValue={(value) => (value === 0 ? t('settings.playback.crossfadeOff') : `${value}s`)}
                />
              </SettingsControlBlock>
            </SettingsListGroup>

            <SettingsListGroup title={t('settings.groups.audio')}>
              <SettingsControlBlock
                icon="wifi-outline"
                title={t('settings.audio.streamingQuality')}
                description={t('settings.audio.streamingQualityHint')}
              >
                <SegmentedControl<AudioQuality>
                  label={t('settings.audio.streamingQuality')}
                  type="radio"
                  size="small"
                  value={musicPreferences?.audioQuality ?? 'normal'}
                  onChange={(value) => handleMusicPreferenceUpdate({ audioQuality: value })}
                >
                  <SegmentedControlItem value="low">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.low')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="normal">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.normal')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="high">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.high')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="very_high">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.veryHigh')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsControlBlock
                icon="cloud-download-outline"
                title={t('settings.audio.downloadQuality')}
                description={t('settings.audio.downloadQualityHint')}
              >
                <SegmentedControl<AudioQuality>
                  label={t('settings.audio.downloadQuality')}
                  type="radio"
                  size="small"
                  value={musicPreferences?.downloadQuality ?? 'normal'}
                  onChange={(value) => handleMusicPreferenceUpdate({ downloadQuality: value })}
                >
                  <SegmentedControlItem value="low">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.low')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="normal">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.normal')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="high">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.high')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="very_high">
                    <SegmentedControlItemText numberOfLines={1}>{t('settings.options.veryHigh')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                </SegmentedControl>
              </SettingsControlBlock>

              <SettingsListItem
                icon={<RowIcon name="radio-outline" />}
                title={t('settings.audio.dataSaver')}
                description={t('settings.audio.dataSaverHint')}
                showChevron={false}
                rightElement={
                  <Switch
                    value={musicPreferences?.dataSaver ?? false}
                    onValueChange={(value) => handleMusicPreferenceUpdate({ dataSaver: value })}
                  />
                }
              />
            </SettingsListGroup>

            <SettingsListGroup title={t('settings.groups.privacy')}>
              {privacySettings ? (
                <SettingsControlBlock
                  icon="lock-closed-outline"
                  title={t('settings.privacy.profileVisibility')}
                  description={t('settings.privacy.profileVisibilityHint')}
                >
                  <SegmentedControl<ProfileVisibility>
                    label={t('settings.privacy.profileVisibility')}
                    type="radio"
                    size="small"
                    value={privacySettings.profileVisibility ?? 'public'}
                    onChange={(value) => handlePrivacyUpdate({ profileVisibility: value })}
                  >
                    <SegmentedControlItem value="public">
                      <SegmentedControlItemText numberOfLines={1}>{t('settings.options.public')}</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="followers_only">
                      <SegmentedControlItemText numberOfLines={1}>{t('settings.options.followers')}</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="private">
                      <SegmentedControlItemText numberOfLines={1}>{t('settings.options.private')}</SegmentedControlItemText>
                    </SegmentedControlItem>
                  </SegmentedControl>
                </SettingsControlBlock>
              ) : null}
              {privacySettings ? (
                <SettingsListItem
                  icon={<RowIcon name="card-outline" />}
                  title={t('settings.privacy.showContactInfo')}
                  description={t('settings.privacy.showContactInfoHint')}
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
                  title={t('settings.privacy.showOnlineStatus')}
                  description={t('settings.privacy.showOnlineStatusHint')}
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
                title={t('settings.privacy.clearCache')}
                description={t('settings.privacy.clearCacheHint')}
                onPress={handleClearCache}
                showChevron={false}
              />
            </SettingsListGroup>

            <SettingsListGroup title={t('settings.groups.about')}>
              <SettingsListItem
                icon={<RowIcon name="information-circle-outline" />}
                title={t('settings.about.version')}
                value={`Syra ${appVersion}`}
                showChevron={false}
              />
              <SettingsListItem
                icon={<RowIcon name="document-text-outline" />}
                title={t('settings.about.terms')}
                onPress={() => Alert.alert(t('settings.about.terms'), t('settings.alerts.termsSoon'))}
              />
              <SettingsListItem
                icon={<RowIcon name="shield-checkmark-outline" />}
                title={t('settings.about.privacyPolicy')}
                onPress={() => Alert.alert(t('settings.about.privacyPolicy'), t('settings.alerts.privacyPolicySoon'))}
              />
              <SettingsListItem
                icon={<RowIcon name="help-circle-outline" />}
                title={t('settings.about.help')}
                onPress={() => Alert.alert(t('settings.about.help'), t('settings.alerts.helpSoon'))}
              />
              <SettingsListItem
                icon={<RowIcon name="flag-outline" />}
                title={t('settings.about.copyright')}
                description={t('settings.about.copyrightHint')}
                onPress={() => router.push('/copyright/report')}
              />
            </SettingsListGroup>

            <SettingsListGroup>
              <SettingsListItem
                icon={<RowIcon name="log-out-outline" destructive />}
                title={t('settings.logOut')}
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
