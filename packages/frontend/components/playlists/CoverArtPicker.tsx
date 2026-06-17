import React, { useMemo, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Image, Platform, Alert, ActivityIndicator } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useImagePicker } from '@/hooks/useImagePicker';
import { resolveCatalogImageUrl } from '@/utils/catalogImages';

interface CoverArtPickerProps {
  value?: string; // Image ID (MongoDB ObjectId string) or URL for display
  onChange: (imageId: string | null) => void; // Callback with image ID
  size?: number;
  disabled?: boolean;
}

/**
 * Cover Art Picker Component
 * Allows users to select a cover image for playlists
 */
export const CoverArtPicker: React.FC<CoverArtPickerProps> = ({
  value,
  onChange,
  size = 200,
  disabled = false,
}) => {
  const theme = useTheme();
  // Web-only hover state to fade in the "change cover" overlay.
  const [isHovered, setIsHovered] = useState(false);
  const { pickImage, takePhoto, uploadImage, isUploading } = useImagePicker({
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });

  // Convert image ID to display URL
  const imageUrl = useMemo(() => {
    if (!value) return null;
    return resolveCatalogImageUrl(value) ?? null;
  }, [value]);

  const handlePickImage = async () => {
    if (disabled || isUploading) return;

    // Show action sheet to choose source
    if (Platform.OS === 'web') {
      // Web: Just open library picker
      const result = await pickImage('library');
      if (result) {
        const imageId = await uploadImage(result);
        if (imageId) {
          onChange(imageId);
        }
      }
    } else {
      // Native: Show options
      Alert.alert(
        'Select Cover Art',
        'Choose an option',
        [
          {
            text: 'Photo Library',
            onPress: async () => {
              const result = await pickImage('library');
              if (result) {
                const imageId = await uploadImage(result);
                if (imageId) {
                  onChange(imageId);
                }
              }
            },
          },
          {
            text: 'Take Photo',
            onPress: async () => {
              const result = await takePhoto();
              if (result) {
                const imageId = await uploadImage(result);
                if (imageId) {
                  onChange(imageId);
                }
              }
            },
          },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => onChange(null),
          },
          {
            text: 'Cancel',
            style: 'cancel',
          },
        ],
        { cancelable: true }
      );
    }
  };

  return (
    <Pressable
      onPress={handlePickImage}
      disabled={disabled}
      onPointerEnter={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
      onPointerLeave={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
      style={[
        styles.container,
        {
          width: size,
          height: size,
          backgroundColor: theme.colors.backgroundSecondary,
          borderColor: theme.colors.border,
          opacity: disabled || isUploading ? 0.5 : 1,
        },
      ]}
    >
      {isUploading ? (
        <View style={styles.uploadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={[styles.uploadingText, { color: theme.colors.textSecondary }]}>
            Uploading...
          </Text>
        </View>
      ) : imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={[styles.image, { width: size, height: size }]}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.placeholder}>
          <MaterialCommunityIcons
            name="image-plus"
            size={size * 0.3}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.placeholderText, { color: theme.colors.textSecondary }]}>
            Add Cover Art
          </Text>
        </View>
      )}
      
      {/* Overlay - shown on press/hover (web only) */}
      {Platform.OS === 'web' && (
        <View
          style={[
            styles.overlay,
            {
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              opacity: isHovered ? 1 : 0,
            },
          ]}
        >
          <MaterialCommunityIcons
            name="camera"
            size={24}
            color="#FFFFFF"
          />
          <Text style={styles.overlayText}>
            {value ? 'Change' : 'Add'} Cover Art
          </Text>
        </View>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: 'dashed',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  image: {
    borderRadius: 20,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 12,
  },
  placeholderText: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    opacity: 0,
    borderRadius: 20,
    ...Platform.select({
      web: {
        transition: 'opacity 0.2s',
        cursor: 'pointer',
      },
    }),
  },
  overlayText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  uploadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  uploadingText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
