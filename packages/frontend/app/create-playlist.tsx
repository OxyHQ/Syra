import React, { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { PlaylistVisibility } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface FormErrors {
  name?: string;
  description?: string;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 300;

/**
 * Create Playlist Screen
 * Spotify-like playlist creation interface
 */
const CreatePlaylistScreen: React.FC = () => {
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
      
      // Navigate to created playlist
      router.replace(`/playlist/${playlist.id}` as any);
    } catch (error: any) {
      console.error('Failed to create playlist:', error);
      toast.error(error?.message || 'Failed to create playlist. Please try again.');
    } finally {
      setIsCreating(false);
    }
  }, [name, description, coverArt, visibility, isAuthenticated, router]);

  const handleGoBack = useCallback(() => {
    if (!isCreating) {
      router.back();
    }
  }, [isCreating, router]);

  const visibilityOptions = [
    { label: 'Public', value: PlaylistVisibility.PUBLIC, description: 'Anyone can find and play' },
    { label: 'Private', value: PlaylistVisibility.PRIVATE, description: 'Only you can access' },
    { label: 'Unlisted', value: PlaylistVisibility.UNLISTED, description: 'Only accessible via link' },
  ];

  return (
    <>
      <SEO title="Create Playlist - Musico" description="Create a new playlist" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: theme.colors.background }]}
      >
        {/* Header */}
        <View
          style={[
            styles.header,
            {
              backgroundColor: theme.colors.background,
              borderBottomColor: theme.colors.border,
              paddingTop: Math.max(insets.top, 8),
            },
          ]}
        >
          <Pressable
            onPress={handleGoBack}
            disabled={isCreating}
            style={styles.backButton}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={24}
              color={theme.colors.text}
            />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Create Playlist
          </Text>
          <Pressable
            onPress={handleCreate}
            disabled={isCreating || !name.trim()}
            style={[
              styles.createHeaderButton,
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
              <Text style={styles.createHeaderButtonText}>Create</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 16 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Cover Art Section */}
          <View style={styles.coverArtSection}>
            <CoverArtPicker
              value={coverArt || undefined}
              onChange={setCoverArt}
              size={180}
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
      </KeyboardAvoidingView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  backButton: {
    padding: 6,
    borderRadius: 24,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  createHeaderButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 24,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  createHeaderButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  coverArtSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  formSection: {
    gap: 16,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  input: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
  },
  textArea: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 90,
  },
  errorText: {
    fontSize: 12,
    marginTop: -2,
  },
  characterCount: {
    fontSize: 11,
    textAlign: 'right',
  },
  visibilityOptions: {
    gap: 10,
  },
  visibilityOption: {
    padding: 12,
    borderRadius: 16,
    borderWidth: 1.5,
    gap: 3,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  visibilityOptionLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  visibilityOptionDescription: {
    fontSize: 12,
  },
});

export default CreatePlaylistScreen;

