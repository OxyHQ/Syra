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
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { copyrightService } from '@/services/copyrightService';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { z } from 'zod';

const copyrightReportFormSchema = z.object({
  trackId: z.string().min(1, 'Please select a track to report'),
  reason: z.string().trim().min(1, 'Please provide a reason for the copyright violation'),
});

function getCopyrightReportErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as { data?: unknown }).data;
      if (data && typeof data === 'object' && 'message' in data) {
        const message = (data as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
  }
  return error instanceof Error
    ? error.message
    : 'Failed to submit report. Please try again.';
}

/**
 * Copyright Report Screen
 * Public screen to report copyright violations
 */
const CopyrightReportScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [reason, setReason] = useState('');

  const debouncedQuery = useDebouncedValue(searchQuery, 500);
  const trimmedDebouncedQuery = debouncedQuery.trim();

  const {
    data: trackSearchData,
    isLoading: isSearching,
    isError: isSearchError,
  } = useQuery({
    queryKey: ['copyright', 'trackSearch', trimmedDebouncedQuery],
    queryFn: () => musicService.searchTracks(trimmedDebouncedQuery, { limit: 10 }),
    enabled: trimmedDebouncedQuery.length > 0 && !selectedTrack,
    staleTime: 1000 * 60,
  });

  const searchResults = trackSearchData?.tracks ?? [];

  const submitReportMutation = useMutation({
    mutationFn: (input: { trackId: string; reason: string }) =>
      copyrightService.reportCopyrightViolation(input),
    onSuccess: () => {
      toast.success('Copyright violation report submitted successfully');
      setSelectedTrack(null);
      setSearchQuery('');
      setReason('');
      setTimeout(() => {
        router.back();
      }, 1500);
    },
    onError: (error: unknown) => {
      console.error('Failed to submit copyright report:', error);
      toast.error(getCopyrightReportErrorMessage(error));
    },
  });

  const isSubmitting = submitReportMutation.isPending;

  const handleTrackSelect = useCallback((track: Track) => {
    setSelectedTrack(track);
    setSearchQuery(track.title);
  }, []);

  const handleSubmit = useCallback(() => {
    const parsed = copyrightReportFormSchema.safeParse({
      trackId: selectedTrack?.id,
      reason,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message || 'Please complete the form');
      return;
    }

    submitReportMutation.mutate(parsed.data);
  }, [reason, selectedTrack, submitReportMutation]);

  const handleGoBack = useCallback(() => {
    if (!isSubmitting) {
      router.back();
    }
  }, [isSubmitting, router]);

  return (
    <>
      <SEO title="Report Copyright Violation - Syra" description="Report a copyright violation" />
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
              // Top safe-area is cleared by the shell's TopBar (single
              // authority); this in-panel header only needs base padding.
              paddingTop: 8,
            },
          ]}
        >
          <Pressable
            onPress={handleGoBack}
            disabled={isSubmitting}
            style={styles.backButton}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={24}
              color={theme.colors.text}
            />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Report Copyright Violation
          </Text>
          <View style={{ width: 24 }} />
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
          {/* Instructions */}
          <View style={styles.section}>
            <Text style={[styles.instructions, { color: theme.colors.textSecondary }]}>
              If you believe a track on Syra violates copyright, please search for the track below and provide details about the violation.
            </Text>
          </View>

          {/* Track Search */}
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.colors.text }]}>
              Search for Track *
            </Text>
            <View style={styles.searchContainer}>
              <TextInput
                style={[
                  styles.searchInput,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    color: theme.colors.text,
                    borderColor: selectedTrack ? theme.colors.primary : theme.colors.border,
                  },
                ]}
                placeholder="Search by track name or artist..."
                placeholderTextColor={theme.colors.textSecondary}
                value={searchQuery}
                onChangeText={setSearchQuery}
                editable={!isSubmitting}
                autoFocus
              />
            {isSearching && (
                <ActivityIndicator
                  size="small"
                  color={theme.colors.primary}
                  style={styles.searchLoader}
                />
              )}
              {isSearchError && (
                <Text style={[styles.errorText, { color: theme.colors.error }]}>
                  Failed to search tracks. Please try again.
                </Text>
              )}
            </View>

            {/* Search Results */}
            {searchResults.length > 0 && !selectedTrack && (
              <View style={[styles.resultsContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {searchResults.map((track) => (
                  <Pressable
                    key={track.id}
                    onPress={() => handleTrackSelect(track)}
                    style={[styles.resultItem, { borderBottomColor: theme.colors.border }]}
                  >
                    <View style={styles.resultInfo}>
                      <Text style={[styles.resultTitle, { color: theme.colors.text }]}>
                        {track.title}
                      </Text>
                      <Text style={[styles.resultArtist, { color: theme.colors.textSecondary }]}>
                        {track.artistName}
                      </Text>
                    </View>
                    <MaterialCommunityIcons
                      name="chevron-right"
                      size={20}
                      color={theme.colors.textSecondary}
                    />
                  </Pressable>
                ))}
              </View>
            )}

            {/* Selected Track */}
            {selectedTrack && (
              <View style={[styles.selectedTrack, { backgroundColor: theme.colors.primary + '20', borderColor: theme.colors.primary }]}>
                <View style={styles.selectedTrackInfo}>
                  <MaterialCommunityIcons
                    name="music"
                    size={20}
                    color={theme.colors.primary}
                  />
                  <View style={styles.selectedTrackText}>
                    <Text style={[styles.selectedTrackTitle, { color: theme.colors.text }]}>
                      {selectedTrack.title}
                    </Text>
                    <Text style={[styles.selectedTrackArtist, { color: theme.colors.textSecondary }]}>
                      {selectedTrack.artistName}
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => {
                    setSelectedTrack(null);
                    setSearchQuery('');
                  }}
                  style={styles.removeButton}
                >
                  <MaterialCommunityIcons
                    name="close"
                    size={20}
                    color={theme.colors.text}
                  />
                </Pressable>
              </View>
            )}
          </View>

          {/* Reason Input */}
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.colors.text }]}>
              Reason for Copyright Violation *
            </Text>
            <TextInput
              style={[
                styles.reasonInput,
                {
                  backgroundColor: theme.colors.backgroundSecondary,
                  color: theme.colors.text,
                  borderColor: theme.colors.border,
                },
              ]}
              placeholder="Please provide details about the copyright violation..."
              placeholderTextColor={theme.colors.textSecondary}
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              editable={!isSubmitting}
            />
            <Text style={[styles.characterCount, { color: theme.colors.textSecondary }]}>
              {reason.length} characters
            </Text>
          </View>

          {/* Submit Button */}
          <Pressable
            onPress={handleSubmit}
            disabled={isSubmitting || !selectedTrack || !reason.trim()}
            style={[
              styles.submitButton,
              {
                backgroundColor:
                  isSubmitting || !selectedTrack || !reason.trim()
                    ? theme.colors.textSecondary
                    : theme.colors.primary,
                opacity: isSubmitting || !selectedTrack || !reason.trim() ? 0.6 : 1,
              },
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
            ) : (
              <Text style={[styles.submitButtonText, { color: theme.colors.primaryForeground }]}>Submit Report</Text>
            )}
          </Pressable>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 24,
  },
  section: {
    gap: 8,
  },
  instructions: {
    fontSize: 14,
    lineHeight: 20,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  searchContainer: {
    position: 'relative',
  },
  searchInput: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    paddingRight: 40,
  },
  searchLoader: {
    position: 'absolute',
    right: 12,
    top: 12,
  },
  errorText: {
    fontSize: 13,
    marginTop: 6,
  },
  resultsContainer: {
    borderRadius: 12,
    marginTop: 8,
    maxHeight: 300,
    overflow: 'hidden',
  },
  resultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  resultInfo: {
    flex: 1,
    gap: 4,
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  resultArtist: {
    fontSize: 13,
  },
  selectedTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
  },
  selectedTrackInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  selectedTrackText: {
    flex: 1,
    gap: 4,
  },
  selectedTrackTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  selectedTrackArtist: {
    fontSize: 13,
  },
  removeButton: {
    padding: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  reasonInput: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 120,
  },
  characterCount: {
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
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
});

export default CopyrightReportScreen;



