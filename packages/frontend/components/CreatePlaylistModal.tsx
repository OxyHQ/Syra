import React, { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Modal,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Portal } from '@/components/Portal';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { PlaylistVisibility } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { toast } from 'sonner';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const AnimatedView = Animated.createAnimatedComponent(View);

interface CreatePlaylistModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: (playlistId: string) => void;
}

interface FormErrors {
  name?: string;
  description?: string;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 300;

/**
 * Create Playlist Modal Component
 * Spotify-like playlist creation interface
 */
export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  visible,
  onClose,
  onSuccess,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useOxy();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<PlaylistVisibility>(PlaylistVisibility.PRIVATE);
  const [isCreating, setIsCreating] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  // Animation values
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.9);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 200 });
      scale.value = withTiming(1, {
        duration: 300,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      opacity.value = withTiming(0, { duration: 150 });
      scale.value = withTiming(0.9, { duration: 150 });
    }
  }, [visible]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const contentStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  // Reset form when modal closes
  useEffect(() => {
    if (!visible) {
      setName('');
      setDescription('');
      setCoverArt(null);
      setVisibility(PlaylistVisibility.PRIVATE);
      setErrors({});
    }
  }, [visible]);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    // Validate name
    const trimmedName = name.trim();
    if (!trimmedName) {
      newErrors.name = 'Playlist name is required';
    } else if (trimmedName.length > NAME_MAX_LENGTH) {
      newErrors.name = `Name must be ${NAME_MAX_LENGTH} characters or less`;
    }

    // Validate description
    if (description.trim().length > DESCRIPTION_MAX_LENGTH) {
      newErrors.description = `Description must be ${DESCRIPTION_MAX_LENGTH} characters or less`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCreate = useCallback(async () => {
    if (!isAuthenticated) {
      toast.error('You must be logged in to create playlists');
      return;
    }

    if (!validateForm()) {
      return;
    }

    setIsCreating(true);
    try {
      const playlist = await musicService.createPlaylist({
        name: name.trim(),
        description: description.trim() || undefined,
        coverArt: coverArt || undefined,
        isPublic: visibility === PlaylistVisibility.PUBLIC,
        visibility: visibility,
      });

      toast.success(`Playlist "${playlist.name}" created successfully`);
      
      // Close modal
      onClose();

      // Navigate to playlist or call success callback
      if (onSuccess) {
        onSuccess(playlist.id);
      } else {
        router.push(`/playlist/${playlist.id}` as any);
      }
    } catch (error: any) {
      console.error('Failed to create playlist:', error);
      toast.error(error?.message || 'Failed to create playlist. Please try again.');
    } finally {
      setIsCreating(false);
    }
  }, [name, description, coverArt, visibility, isAuthenticated, onClose, onSuccess, router]);

  const handleBackdropPress = useCallback(() => {
    if (!isCreating) {
      onClose();
    }
  }, [isCreating, onClose]);

  const visibilityOptions = [
    { label: 'Public', value: PlaylistVisibility.PUBLIC, description: 'Anyone can find and play' },
    { label: 'Private', value: PlaylistVisibility.PRIVATE, description: 'Only you can access' },
    { label: 'Unlisted', value: PlaylistVisibility.UNLISTED, description: 'Only accessible via link' },
  ];

  const modalContent = (
    <GestureHandlerRootView style={styles.container}>
      <Pressable
        style={StyleSheet.absoluteFillObject}
        onPress={handleBackdropPress}
      >
        <AnimatedView
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(0, 0, 0, 0.7)' },
            backdropStyle,
          ]}
        />
      </Pressable>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <Pressable onPress={(e) => e.stopPropagation()}>
          <AnimatedView
            style={[
              styles.modalContent,
              {
                backgroundColor: theme.colors.background,
                maxHeight: '90%',
                paddingTop: insets.top,
                paddingBottom: insets.bottom,
              },
              contentStyle,
            ]}
          >
            {/* Header */}
            <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
              <Text style={[styles.title, { color: theme.colors.text }]}>
                Create Playlist
              </Text>
              <Pressable
                onPress={onClose}
                disabled={isCreating}
                style={styles.closeButton}
              >
                <MaterialCommunityIcons
                  name="close"
                  size={24}
                  color={theme.colors.text}
                />
              </Pressable>
            </View>

            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Cover Art Section */}
              <View style={styles.coverArtSection}>
                <CoverArtPicker
                  value={coverArt || undefined}
                  onChange={setCoverArt}
                  size={200}
                  disabled={isCreating}
                />
              </View>

              {/* Form Fields */}
              <View style={styles.formSection}>
                {/* Name Input */}
                <View style={styles.inputGroup}>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: theme.colors.backgroundSecondary,
                        color: theme.colors.text,
                        borderColor: errors.name ? theme.colors.error : theme.colors.border,
                      },
                    ]}
                    placeholder="Playlist name"
                    placeholderTextColor={theme.colors.textSecondary}
                    value={name}
                    onChangeText={(text) => {
                      setName(text);
                      if (errors.name) {
                        setErrors((prev) => ({ ...prev, name: undefined }));
                      }
                    }}
                    maxLength={NAME_MAX_LENGTH}
                    editable={!isCreating}
                    autoFocus
                  />
                  {errors.name && (
                    <Text style={[styles.errorText, { color: theme.colors.error }]}>
                      {errors.name}
                    </Text>
                  )}
                  <Text style={[styles.characterCount, { color: theme.colors.textSecondary }]}>
                    {name.length}/{NAME_MAX_LENGTH}
                  </Text>
                </View>

                {/* Description Input */}
                <View style={styles.inputGroup}>
                  <TextInput
                    style={[
                      styles.textArea,
                      {
                        backgroundColor: theme.colors.backgroundSecondary,
                        color: theme.colors.text,
                        borderColor: errors.description ? theme.colors.error : theme.colors.border,
                      },
                    ]}
                    placeholder="Add a description (optional)"
                    placeholderTextColor={theme.colors.textSecondary}
                    value={description}
                    onChangeText={(text) => {
                      setDescription(text);
                      if (errors.description) {
                        setErrors((prev) => ({ ...prev, description: undefined }));
                      }
                    }}
                    maxLength={DESCRIPTION_MAX_LENGTH}
                    multiline
                    numberOfLines={4}
                    textAlignVertical="top"
                    editable={!isCreating}
                  />
                  {errors.description && (
                    <Text style={[styles.errorText, { color: theme.colors.error }]}>
                      {errors.description}
                    </Text>
                  )}
                  <Text style={[styles.characterCount, { color: theme.colors.textSecondary }]}>
                    {description.length}/{DESCRIPTION_MAX_LENGTH}
                  </Text>
                </View>

                {/* Privacy/Visibility Selector */}
                <View style={styles.inputGroup}>
                  <Text style={[styles.label, { color: theme.colors.text }]}>
                    Privacy
                  </Text>
                  <View style={styles.visibilityOptions}>
                    {visibilityOptions.map((option) => (
                      <Pressable
                        key={option.value}
                        onPress={() => !isCreating && setVisibility(option.value)}
                        style={[
                          styles.visibilityOption,
                          {
                            backgroundColor:
                              visibility === option.value
                                ? theme.colors.primary
                                : theme.colors.backgroundSecondary,
                            borderColor:
                              visibility === option.value
                                ? theme.colors.primary
                                : theme.colors.border,
                          },
                        ]}
                        disabled={isCreating}
                      >
                        <Text
                          style={[
                            styles.visibilityOptionLabel,
                            {
                              color:
                                visibility === option.value
                                  ? '#FFFFFF'
                                  : theme.colors.text,
                            },
                          ]}
                        >
                          {option.label}
                        </Text>
                        <Text
                          style={[
                            styles.visibilityOptionDescription,
                            {
                              color:
                                visibility === option.value
                                  ? 'rgba(255, 255, 255, 0.8)'
                                  : theme.colors.textSecondary,
                            },
                          ]}
                        >
                          {option.description}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            </ScrollView>

            {/* Footer Actions */}
            <View
              style={[
                styles.footer,
                { borderTopColor: theme.colors.border },
              ]}
            >
              <Pressable
                onPress={onClose}
                disabled={isCreating}
                style={[
                  styles.cancelButton,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    opacity: isCreating ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.cancelButtonText, { color: theme.colors.text }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={handleCreate}
                disabled={isCreating || !name.trim()}
                style={[
                  styles.createButton,
                  {
                    backgroundColor:
                      isCreating || !name.trim()
                        ? theme.colors.textSecondary
                        : theme.colors.primary,
                    opacity: isCreating || !name.trim() ? 0.6 : 1,
                  },
                ]}
              >
                {isCreating ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.createButtonText}>Create</Text>
                )}
              </Pressable>
            </View>
          </AnimatedView>
        </Pressable>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );

  if (Platform.OS === 'web') {
    return (
      <Portal>
        <Modal
          visible={visible}
          transparent
          animationType="none"
          onRequestClose={onClose}
        >
          {modalContent}
        </Modal>
      </Portal>
    );
  }

  return (
    <Portal>
      <Modal
        visible={visible}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={onClose}
      >
        {modalContent}
      </Modal>
    </Portal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  keyboardView: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '100%',
    maxWidth: 600,
    borderRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      web: {
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
      default: {
        elevation: 10,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  closeButton: {
    padding: 8,
    borderRadius: 20,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 24,
    gap: 24,
  },
  coverArtSection: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  formSection: {
    gap: 20,
  },
  inputGroup: {
    gap: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  input: {
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  textArea: {
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 100,
  },
  errorText: {
    fontSize: 13,
    marginTop: -4,
  },
  characterCount: {
    fontSize: 12,
    textAlign: 'right',
  },
  visibilityOptions: {
    gap: 12,
  },
  visibilityOption: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 2,
    gap: 4,
  },
  visibilityOptionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  visibilityOptionDescription: {
    fontSize: 13,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  createButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});






