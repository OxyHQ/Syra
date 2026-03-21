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
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { copyrightService } from '@/services/copyrightService';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

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
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchResults, setSearchResults] = useState<Track[]>([]);

  const debouncedQuery = useDebouncedValue(searchQuery, 500);

  // Search tracks when query changes
  useEffect(() => {
    const performSearch = async () => {
      if (!debouncedQuery.trim()) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const result = await musicService.searchTracks(debouncedQuery, { limit: 10 });
        setSearchResults(result.tracks);
      } catch (error: any) {
        console.error('Failed to search tracks:', error);
        toast.error('Failed to search tracks. Please try again.');
      } finally {
        setIsSearching(false);
      }
    };

    performSearch();
  }, [debouncedQuery]);

  const handleTrackSelect = useCallback((track: Track) => {
    setSelectedTrack(track);
    setSearchQuery(track.title);
    setSearchResults([]);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedTrack) {
      toast.error('Please select a track to report');
      return;
    }

    if (!reason.trim()) {
      toast.error('Please provide a reason for the copyright violation');
      return;
    }

    setIsSubmitting(true);
    try {
      await copyrightService.reportCopyrightViolation({
        trackId: selectedTrack.id,
        reason: reason.trim(),
      });

      toast.success('Copyright violation report submitted successfully');
      
      // Reset form
      setSelectedTrack(null);
      setSearchQuery('');
      setReason('');
      setSearchResults([]);

      // Navigate back after a short delay
      setTimeout(() => {
        router.back();
      }, 1500);
    } catch (error: any) {
      console.error('Failed to submit copyright report:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to submit report. Please try again.';
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedTrack, reason, router]);

  const handleGoBack = useCallback(() => {
    if (!isSubmitting) {
      router.back();
    }
  }, [isSubmitting, router]);

  return (
    <>
      <SEO title="Report Copyright Violation - Musico" description="Report a copyright violation" />
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
              If you believe a track on Musico violates copyright, please search for the track below and provide details about the violation.
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
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>Submit Report</Text>
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
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default CopyrightReportScreen;






