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
import { useMutation } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { artistService } from '@/services/artistService';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

interface FormErrors {
    name?: string;
    bio?: string;
}

const NAME_MAX_LENGTH = 100;
const BIO_MAX_LENGTH = 500;

const artistRegistrationFormSchema = z.object({
    name: z.string().trim().min(1, 'Artist name is required').max(NAME_MAX_LENGTH, `Name must be ${NAME_MAX_LENGTH} characters or less`),
    bio: z.string().trim().max(BIO_MAX_LENGTH, `Bio must be ${BIO_MAX_LENGTH} characters or less`),
    image: z.string().nullable(),
    genre: z.string().trim(),
});

function getErrorMessage(error: unknown): string | undefined {
    return error instanceof Error ? error.message : undefined;
}

/**
 * Artist Registration Screen
 * Allows users to register as artists
 */
const ArtistRegisterScreen: React.FC = () => {
    const theme = useTheme();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { isAuthenticated } = useOxy();

    const [name, setName] = useState('');
    const [bio, setBio] = useState('');
    const [image, setImage] = useState<string | null>(null);
    const [genre, setGenre] = useState('');
    const [errors, setErrors] = useState<FormErrors>({});
    const registerArtistMutation = useMutation({
        mutationFn: (input: z.infer<typeof artistRegistrationFormSchema>) =>
            artistService.registerAsArtist({
                name: input.name,
                bio: input.bio || undefined,
                image: input.image || undefined,
                genres: input.genre ? [input.genre] : undefined,
            }),
        onSuccess: (artist) => {
            toast.success(`Artist profile "${artist.name}" created successfully`);
            router.replace('/artist/dashboard');
        },
        onError: (error: unknown) => {
            console.error('Failed to register as artist:', error);
            toast.error(getErrorMessage(error) || 'Failed to register as artist. Please try again.');
        },
    });
    const isRegistering = registerArtistMutation.isPending;

    // Redirect if not authenticated
    useEffect(() => {
        if (!isAuthenticated) {
            toast.error('You must sign in to create an artist profile');
            router.replace('/');
        }
    }, [isAuthenticated, router]);

    const validateForm = useCallback((): z.infer<typeof artistRegistrationFormSchema> | null => {
        const newErrors: FormErrors = {};
        const parsed = artistRegistrationFormSchema.safeParse({
            name,
            bio,
            image,
            genre,
        });

        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                const key = issue.path[0];
                if (key === 'name' || key === 'bio') {
                    newErrors[key] = issue.message;
                }
            }
        }

        setErrors(newErrors);
        return parsed.success ? parsed.data : null;
    }, [bio, genre, image, name]);

    const handleRegister = useCallback(async () => {
        if (!isAuthenticated) {
            toast.error('You must be logged in to register as an artist');
            return;
        }

        const formData = validateForm();
        if (!formData) {
            return;
        }

        registerArtistMutation.mutate(formData);
    }, [isAuthenticated, registerArtistMutation, validateForm]);

    const handleGoBack = useCallback(() => {
        if (!isRegistering) {
            router.back();
        }
    }, [isRegistering, router]);

    return (
        <>
            <SEO title="Register as Artist - Syra" description="Create your artist profile" />
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
                            // Top safe-area is cleared by the shell's TopBar
                            // (single authority); this in-panel header only
                            // needs base padding.
                            paddingTop: 8,
                        },
                    ]}
                >
                    <Pressable
                        onPress={handleGoBack}
                        disabled={isRegistering}
                        style={styles.backButton}
                    >
                        <MaterialCommunityIcons
                            name="arrow-left"
                            size={24}
                            color={theme.colors.text}
                        />
                    </Pressable>
                    <Text style={[styles.title, { color: theme.colors.text }]}>
                        Register as Artist
                    </Text>
                    <View style={{ width: 24 }} />
                </View>

                {!isAuthenticated ? (
                    <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                        <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                            Redirecting...
                        </Text>
                    </View>
                ) : (
                <ScrollView
                    style={styles.scrollView}
                    contentContainerStyle={[
                        styles.scrollContent,
                        { paddingBottom: insets.bottom + 16 },
                    ]}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* Image Section */}
                    <View style={styles.imageSection}>
                        <CoverArtPicker
                            value={image || undefined}
                            onChange={setImage}
                            size={180}
                            disabled={isRegistering}
                        />
                    </View>

                    {/* Form Fields */}
                    <View style={styles.formSection}>
                        {/* Name Input */}
                        <View style={styles.inputGroup}>
                            <Text style={[styles.label, { color: theme.colors.text }]}>
                                Artist Name *
                            </Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.colors.backgroundSecondary,
                                        color: theme.colors.text,
                                        borderColor: errors.name ? theme.colors.error : theme.colors.border,
                                    },
                                ]}
                                placeholder="Your artist name"
                                placeholderTextColor={theme.colors.textSecondary}
                                value={name}
                                onChangeText={(text) => {
                                    setName(text);
                                    if (errors.name) {
                                        setErrors((prev) => ({ ...prev, name: undefined }));
                                    }
                                }}
                                maxLength={NAME_MAX_LENGTH}
                                editable={!isRegistering}
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

                        {/* Bio Input */}
                        <View style={styles.inputGroup}>
                            <Text style={[styles.label, { color: theme.colors.text }]}>
                                Bio (optional)
                            </Text>
                            <TextInput
                                style={[
                                    styles.textArea,
                                    {
                                        backgroundColor: theme.colors.backgroundSecondary,
                                        color: theme.colors.text,
                                        borderColor: errors.bio ? theme.colors.error : theme.colors.border,
                                    },
                                ]}
                                placeholder="Tell us about yourself..."
                                placeholderTextColor={theme.colors.textSecondary}
                                value={bio}
                                onChangeText={(text) => {
                                    setBio(text);
                                    if (errors.bio) {
                                        setErrors((prev) => ({ ...prev, bio: undefined }));
                                    }
                                }}
                                maxLength={BIO_MAX_LENGTH}
                                multiline
                                numberOfLines={4}
                                textAlignVertical="top"
                                editable={!isRegistering}
                            />
                            {errors.bio && (
                                <Text style={[styles.errorText, { color: theme.colors.error }]}>
                                    {errors.bio}
                                </Text>
                            )}
                            <Text style={[styles.characterCount, { color: theme.colors.textSecondary }]}>
                                {bio.length}/{BIO_MAX_LENGTH}
                            </Text>
                        </View>

                        {/* Genre Input */}
                        <View style={styles.inputGroup}>
                            <Text style={[styles.label, { color: theme.colors.text }]}>
                                Genre (optional)
                            </Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.colors.backgroundSecondary,
                                        color: theme.colors.text,
                                        borderColor: theme.colors.border,
                                    },
                                ]}
                                placeholder="Pop, Rock, Electronic..."
                                placeholderTextColor={theme.colors.textSecondary}
                                value={genre}
                                onChangeText={setGenre}
                                editable={!isRegistering}
                            />
                        </View>
                    </View>

                    {/* Register Button */}
                    <Pressable
                        onPress={handleRegister}
                        disabled={isRegistering || !name.trim()}
                        style={[
                            styles.submitButton,
                            {
                                backgroundColor:
                                    isRegistering || !name.trim()
                                        ? theme.colors.textSecondary
                                        : theme.colors.primary,
                                opacity: isRegistering || !name.trim() ? 0.6 : 1,
                            },
                        ]}
                    >
                        {isRegistering ? (
                            <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
                        ) : (
                            <Text style={[styles.submitButtonText, { color: theme.colors.primaryForeground }]}>Register as Artist</Text>
                        )}
                    </Pressable>
                </ScrollView>
                )}
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
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        gap: 16,
    },
    imageSection: {
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
    submitButton: {
        paddingVertical: 14,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 8,
        ...Platform.select({
            web: {
                cursor: 'pointer',
            },
        }),
    },
    submitButtonText: {
        fontSize: 16,
        fontWeight: 'bold',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 12,
    },
    loadingText: {
        fontSize: 14,
    },
});

export default ArtistRegisterScreen;
