/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { useVideoMuteStore } from '@/stores/videoMuteStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';

export interface InitializationResult {
  success: boolean;
  error?: Error;
}

export interface AppInitializationState {
  fontsLoaded: boolean;
  i18nInitialized: boolean;
  notificationsSetup: boolean;
  authReady: boolean;
  appearanceLoaded: boolean;
  videoMuteLoaded: boolean;
}

/**
 * Sets up notifications for native platforms
 */
async function setupNotificationsIfNeeded(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    await setupNotifications();
    await hasNotificationPermission();
  } catch (error) {
    console.warn('Failed to setup notifications:', error);
  }
}

/**
 * Loads video mute state
 */
async function loadVideoMuteState(): Promise<void> {
  try {
    await useVideoMuteStore.getState().loadMutedState();
  } catch (error) {
    console.warn('Failed to load video mute state:', error);
  }
}

/**
 * Main app initialization function
 * Coordinates all initialization steps
 */
export class AppInitializer {
  /**
   * Initializes i18n
   */
  static async initializeI18n(): Promise<InitializationResult> {
    try {
      await initializeI18n();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown i18n error'),
      };
    }
  }

  /**
   * Initializes the entire app
   */
  static async initializeApp(fontsLoaded: boolean): Promise<InitializationResult> {
    if (!fontsLoaded) {
      return {
        success: false,
        error: new Error('Fonts not loaded'),
      };
    }

    try {
      await Promise.allSettled([
        setupNotificationsIfNeeded(),
        loadVideoMuteState(),
      ]);

      // Hide splash screen
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown initialization error'),
      };
    }
  }

  /**
   * Loads eager settings that don't block app initialization
   */
  static async loadEagerSettings(): Promise<void> {
    await Promise.allSettled([
      loadVideoMuteState(),
    ]);
  }
}
