import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';

/**
 * Tells React Query when a device goes on or offline and when the app comes to the
 * front. Services 14's `OxyProvider` did this; Services 15 owns no React Query client,
 * so Studio does it, as the listener app does in its root layout. Without it a query
 * that failed offline (the Go Live room list) never reloads on reconnect. On the web
 * React Query listens to the browser's own online and visibility events.
 */
export function QueryManagers(): null {
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    const appState = AppState.addEventListener('change', (status) => {
      focusManager.setFocused(status === 'active');
    });
    return () => {
      unsubscribeNetInfo();
      appState.remove();
    };
  }, []);
  return null;
}
