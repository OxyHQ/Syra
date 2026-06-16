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
  const { devices, isLoading, transferTo } = useConnect();

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

          {isLoading ? (
            <View style={styles.skeletonList}>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton.Box
                  key={i}
                  width="100%"
                  height={56}
                  borderRadius={8}
                  style={styles.skeletonRow}
                />
              ))}
            </View>
          ) : devices.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              No other devices found
            </Text>
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
    marginBottom: 0,
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 24,
    fontSize: 14,
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
});
