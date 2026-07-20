import React, { useState, useCallback } from 'react';
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
import { useMutation } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { PlaylistVisibility } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { toast } from '@/lib/sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

interface FormErrors {
  name?: string;
  description?: string;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 300;

const createPlaylistFormSchema = z.object({
  name: z.string().trim().min(1, 'Playlist name is required').max(NAME_MAX_LENGTH, `Name must be ${NAME_MAX_LENGTH} characters or less`),
  description: z.string().trim().max(DESCRIPTION_MAX_LENGTH, `Description must be ${DESCRIPTION_MAX_LENGTH} characters or less`),
  coverArt: z.string().nullable(),
  visibility: z.nativeEnum(PlaylistVisibility),
});

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

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
  const [errors, setErrors] = useState<FormErrors>({});
  const createPlaylistMutation = useMutation({
    mutationFn: (input: z.infer<typeof createPlaylistFormSchema>) =>
      musicService.createPlaylist({
        name: input.name,
        description: input.description || undefined,
        coverArt: input.coverArt || undefined,
        visibility: input.visibility,
    }),
    onSuccess: (playlist) => {
      toast.success(`Playlist "${playlist.name}" created successfully`);
      router.replace({ pathname: '/playlist/[id]', params: { id: playlist.id } });
    },
    onError: (error: unknown) => {
      console.error('Failed to create playlist:', error);
      toast.error(getErrorMessage(error) || 'Failed to create playlist. Please try again.');
    },
  });
  const isCreating = createPlaylistMutation.isPending;

  const validateForm = useCallback((): z.infer<typeof createPlaylistFormSchema> | null => {
    const newErrors: FormErrors = {};
    const parsed = createPlaylistFormSchema.safeParse({
      name,
      description,
      coverArt,
      visibility,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === 'name' || key === 'description') {
          newErrors[key] = issue.message;
        }
      }
    }

    setErrors(newErrors);
    return parsed.success ? parsed.data : null;
  }, [coverArt, description, name, visibility]);

  const handleCreate = useCallback(async () => {
    if (!isAuthenticated) {
      toast.error('You must be logged in to create playlists');
      return;
    }

    const formData = validateForm();
    if (!formData) {
      return;
    }

    createPlaylistMutation.mutate(formData);
  }, [createPlaylistMutation, isAuthenticated, validateForm]);

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
      <SEO title="Create Playlist - Syra" description="Create a new playlist" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
      >
        {/* Header */}
        <View
          style={[
            styles.header,
            {
              backgroundColor: theme.colors.backgroundSecondary,
              borderBottomColor: theme.colors.border,
              // Top safe-area is cleared by the shell's TopBar (single
              // authority); this in-panel header only needs base padding.
              paddingTop: 8,
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
              <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
            ) : (
              <Text style={[styles.createHeaderButtonText, { color: theme.colors.primaryForeground }]}>Create</Text>
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
                              ? theme.colors.primaryForeground
                              : theme.colors.text,
                        },
                      ]}
                    >
                      {option.label}
                    </Text>
                    <Text
                      style={[
                        styles.visibilityOptionDescription,
                        visibility === option.value
                          ? { color: theme.colors.primaryForeground, opacity: 0.8 }
                          : { color: theme.colors.textSecondary },
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
