import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, Modal, ScrollView, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Ionicons } from '@expo/vector-icons';

export interface PickerOption<T = string> {
  label: string;
  value: T;
  description?: string;
}

interface SettingsPickerProps<T = string> {
  label: string;
  description?: string;
  value: T;
  options: PickerOption<T>[];
  onValueChange: (value: T) => void;
  formatValue?: (value: T) => string;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Settings picker component (dropdown/select)
 * Shows a modal with options on mobile, or a native select on web
 */
export function SettingsPicker<T = string>({
  label,
  description,
  value,
  options,
  onValueChange,
  formatValue,
  disabled = false,
  style,
}: SettingsPickerProps<T>) {
  const theme = useTheme();
  const [isModalVisible, setIsModalVisible] = useState(false);

  const selectedOption = options.find(opt => opt.value === value);
  const displayValue = formatValue
    ? formatValue(value)
    : selectedOption?.label || String(value);

  const handleSelect = (optionValue: T) => {
    onValueChange(optionValue);
    setIsModalVisible(false);
  };

  // Web: Use native select
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.container,
          { borderBottomColor: theme.colors.border },
          style,
        ]}
      >
        <View style={styles.leftContent}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            {label}
          </Text>
          {description && (
            <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
              {description}
            </Text>
          )}
        </View>
        <select
          value={String(value)}
          onChange={(e) => {
            const selected = options.find(opt => String(opt.value) === e.target.value);
            if (selected) {
              onValueChange(selected.value);
            }
          }}
          disabled={disabled}
          style={{
            padding: '8px 32px 8px 12px',
            borderRadius: '4px',
            border: `1px solid ${theme.colors.border}`,
            backgroundColor: theme.colors.background,
            color: theme.colors.text,
            fontSize: '16px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </View>
    );
  }

  // Mobile: Use modal picker
  return (
    <>
      <Pressable
        onPress={() => !disabled && setIsModalVisible(true)}
        disabled={disabled}
        style={[
          styles.container,
          { borderBottomColor: theme.colors.border },
          disabled && { opacity: 0.5 },
          style,
        ]}
      >
        <View style={styles.leftContent}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            {label}
          </Text>
          {description && (
            <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
              {description}
            </Text>
          )}
        </View>
        <View style={styles.rightContent}>
          <Text style={[styles.value, { color: theme.colors.textSecondary }]}>
            {displayValue}
          </Text>
          <Ionicons
            name="chevron-forward"
            size={20}
            color={theme.colors.textSecondary}
            style={styles.chevron}
          />
        </View>
      </Pressable>

      <Modal
        visible={isModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setIsModalVisible(false)}
        >
          <View
            style={[styles.modalContent, { backgroundColor: theme.colors.background }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={[styles.modalHeader, { borderBottomColor: theme.colors.border }]}>
              <Text style={[styles.modalTitle, { color: theme.colors.text }]}>
                {label}
              </Text>
              <Pressable
                onPress={() => setIsModalVisible(false)}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={24} color={theme.colors.text} />
              </Pressable>
            </View>
            <ScrollView style={styles.modalOptions}>
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <Pressable
                    key={String(option.value)}
                    onPress={() => handleSelect(option.value)}
                    style={[
                      styles.modalOption,
                      isSelected && { backgroundColor: theme.colors.backgroundSecondary },
                    ]}
                  >
                    <View style={styles.modalOptionContent}>
                      <Text
                        style={[
                          styles.modalOptionLabel,
                          { color: isSelected ? theme.colors.primary : theme.colors.text },
                        ]}
                      >
                        {option.label}
                      </Text>
                      {option.description && (
                        <Text
                          style={[styles.modalOptionDescription, { color: theme.colors.textSecondary }]}
                        >
                          {option.description}
                        </Text>
                      )}
                    </View>
                    {isSelected && (
                      <Ionicons name="checkmark" size={24} color={theme.colors.primary} />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  leftContent: {
    flex: 1,
    marginRight: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    lineHeight: 18,
  },
  rightContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  value: {
    fontSize: 16,
  },
  chevron: {
    marginLeft: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  modalCloseButton: {
    padding: 4,
  },
  modalOptions: {
    maxHeight: 400,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  modalOptionContent: {
    flex: 1,
  },
  modalOptionLabel: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  modalOptionDescription: {
    fontSize: 14,
    lineHeight: 18,
  },
});






