import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { Device, DeviceType } from '@syra/shared-types';
import { useConnect } from '@/hooks/useConnect';
import { useCast } from '@/hooks/useCast';
import { EmptyState } from '@/components/common/EmptyState';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('DevicePicker');

// ── Icon mapping ──────────────────────────────────────────────────────────────

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const DEVICE_TYPE_ICON: Record<DeviceType, IconName> = {
  web: 'web',
  mobile: 'cellphone',
  desktop: 'monitor',
  speaker: 'speaker',
};

// ── Sub-components ────────────────────────────────────────────────────────────

interface DeviceRowProps {
  device: Device;
  isActive: boolean;
  onPress: () => void;
}

const DeviceRow: React.FC<DeviceRowProps> = ({ device, isActive, onPress }) => {
  const theme = useTheme();

  const rowStyle = useMemo(
    () => [
      styles.deviceRow,
      isActive && { backgroundColor: theme.colors.backgroundSecondary },
    ],
    [isActive, theme.colors.backgroundSecondary],
  );

  return (
    <Pressable style={rowStyle} onPress={onPress} accessibilityRole="button">
      <MaterialCommunityIcons
        name={DEVICE_TYPE_ICON[device.type] ?? 'devices'}
        size={24}
        color={isActive ? theme.colors.primary : theme.colors.textSecondary}
        style={styles.deviceIcon}
      />
      <View style={styles.deviceInfo}>
        <Text
          style={[styles.deviceName, { color: theme.colors.text }]}
          numberOfLines={1}
        >
          {device.name}
        </Text>
        {isActive && (
          <Text style={[styles.deviceStatus, { color: theme.colors.primary }]}>
            Playing
          </Text>
        )}
      </View>
      {isActive && (
        <MaterialCommunityIcons
          name="volume-high"
          size={18}
          color={theme.colors.primary}
        />
      )}
    </Pressable>
  );
};

// ── DevicePicker ──────────────────────────────────────────────────────────────

interface DevicePickerProps {
  /** Whether the picker modal is visible. */
  visible: boolean;
  /** Current active device ID (from ConnectPlaybackState). */
  activeDeviceId?: string;
  /** Called when the user dismisses the picker. */
  onClose: () => void;
}

/**
 * Modal sheet listing all connected devices and allowing transfer of playback.
 *
 * Consumes useConnect for the live device list; calls transferTo on tap.
 * Follows the same StyleSheet + useTheme pattern as PlayerBar (no NativeWind
 * since PlayerBar uses theme-coloured inline styles and this sheet is tightly
 * coupled to that component's styling layer).
 */
export const DevicePicker: React.FC<DevicePickerProps> = ({
  visible,
  activeDeviceId,
  onClose,
}) => {
  const theme = useTheme();
  const { devices, status, error, retry, transferTo } = useConnect();
  const {
    isSupported: castSupported,
    isCasting,
    deviceName: castDeviceName,
    requestSession: requestCast,
    endSession: endCast,
  } = useCast();

  const backdropStyle = useMemo(
    () => [styles.backdrop],
    [],
  );

  const sheetStyle = useMemo(
    () => [styles.sheet, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }],
    [theme.colors.card, theme.colors.border],
  );

  const handleTransfer = (deviceId: string) => {
    transferTo(deviceId);
    onClose();
  };

  const handleCastPress = async () => {
    try {
      if (isCasting) {
        await endCast();
      } else {
        await requestCast();
      }
    } catch (error) {
      logger.error(isCasting ? 'Failed to end cast session' : 'Failed to start cast session', error);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={backdropStyle} onPress={onClose}>
        {/* Stop propagation so taps inside the sheet don't close it */}
        <Pressable style={sheetStyle} onPress={() => undefined}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              Connect to a Device
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <MaterialCommunityIcons
                name="close"
                size={20}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          </View>

          {status === 'loading' ? (
            <View style={styles.skeletonList}>
              {Array.from({ length: 3 }).map((_, i) => (
                <View
                  key={i}
                  style={[styles.skeletonRow, { backgroundColor: theme.colors.backgroundSecondary }]}
                >
                  <Skeleton.Circle size={36} />
                  <View style={styles.skeletonDeviceInfo}>
                    <Skeleton.Box width="55%" height={14} borderRadius={4} />
                    <Skeleton.Box width="35%" height={12} borderRadius={4} />
                  </View>
                </View>
              ))}
            </View>
          ) : status === 'signed-out' ? (
            <EmptyState
              icon={{ name: 'lock-closed-outline', size: 32 }}
              subtitle="Sign in to see the devices on your account."
              containerStyle={styles.stateContainer}
            />
          ) : status === 'error' ? (
            <EmptyState
              icon={{ name: 'alert-circle-outline', size: 32 }}
              error={{
                title: 'Devices unavailable',
                message: error ?? 'Syra Connect is unreachable right now.',
                onRetry: async () => { retry(); },
              }}
              containerStyle={styles.stateContainer}
            />
          ) : devices.length === 0 ? (
            <EmptyState
              icon={{ name: 'phone-portrait-outline', size: 32 }}
              subtitle="No other devices found"
              containerStyle={styles.stateContainer}
            />
          ) : (
            devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                isActive={device.deviceId === activeDeviceId}
                onPress={() => handleTransfer(device.deviceId)}
              />
            ))
          )}

          {/* Cast & speakers — Google Cast receivers. Omitted entirely when the
              platform/build can't cast, so no dead row is shown. */}
          {castSupported && (
            <View style={[styles.castSection, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
                Cast & speakers
              </Text>
              <Pressable
                style={styles.deviceRow}
                onPress={handleCastPress}
                accessibilityRole="button"
                accessibilityState={{ selected: isCasting }}
                accessibilityLabel={
                  isCasting
                    ? `Disconnect from ${castDeviceName ?? 'Cast'}`
                    : 'Connect to Cast'
                }
              >
                <MaterialCommunityIcons
                  name={isCasting ? 'cast-connected' : 'cast'}
                  size={24}
                  color={isCasting ? theme.colors.primary : theme.colors.textSecondary}
                  style={styles.deviceIcon}
                />
                <View style={styles.deviceInfo}>
                  <Text
                    style={[styles.deviceName, { color: theme.colors.text }]}
                    numberOfLines={1}
                  >
                    {isCasting ? (castDeviceName ?? 'Cast device') : 'Connect to Cast'}
                  </Text>
                  {isCasting && (
                    <Text style={[styles.deviceStatus, { color: theme.colors.primary }]}>
                      Connected
                    </Text>
                  )}
                </View>
                {isCasting && (
                  <Text style={[styles.disconnectText, { color: theme.colors.primary }]}>
                    Disconnect
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  skeletonList: {
    gap: 8,
  },
  skeletonRow: {
    minHeight: 56,
    borderRadius: 8,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  skeletonDeviceInfo: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  // EmptyState defaults to a full-height block painted with the app background;
  // inside this sheet it must size to its content and keep the card colour.
  stateContainer: {
    flex: 0,
    paddingVertical: 20,
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  deviceIcon: {
    marginRight: 12,
  },
  deviceInfo: {
    flex: 1,
    minWidth: 0,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '500',
  },
  deviceStatus: {
    fontSize: 12,
    marginTop: 2,
  },
  castSection: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  disconnectText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
