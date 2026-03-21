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
  Alert,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { artistService } from '@/services/artistService';
import { musicService } from '@/services/musicService';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Artist, Album } from '@syra/shared-types';
import { useFileBlobUrl } from '@/hooks/useBlobUrl';

interface FormErrors {
  title?: string;
  artistId?: string;
  duration?: string;
  audioFile?: string;
  albumTitle?: string;
  releaseDate?: string;
  coverArt?: string;
}

const TITLE_MAX_LENGTH = 100;

/**
 * Artist Upload Screen
 * Allows artists to upload songs and create albums
 */
const ArtistUploadScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useOxy();

  const params = useLocalSearchParams<{ tab?: string }>();
  const [activeTab, setActiveTab] = useState<'song' | 'album'>('song');

  // Check for tab query parameter
  useEffect(() => {
    if (params.tab === 'album') {
      setActiveTab('album');
    } else if (params.tab === 'song') {
      setActiveTab('song');
    }
  }, [params.tab]);

  const [artist, setArtist] = useState<Artist | null>(null);
  const [loading, setLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadsDisabled, setUploadsDisabled] = useState(false);

  // Blob URL management for audio file preview
  const { url: audioBlobUrl, setFile: setAudioBlobFile, clear: clearAudioBlob } = useFileBlobUrl();

  // Song upload state
  const [songTitle, setSongTitle] = useState('');
  const [songAlbumId, setSongAlbumId] = useState<string>('');
  const [songCoverArt, setSongCoverArt] = useState<string | null>(null);
  const [songGenre, setSongGenre] = useState('');
  const [songIsExplicit, setSongIsExplicit] = useState(false);
  const [songDuration, setSongDuration] = useState('');
  const [audioFile, setAudioFile] = useState<{ uri: string; name: string; type: string; file?: File } | null>(null);
  const [songErrors, setSongErrors] = useState<FormErrors>({});

  // Album creation state
  const [albumTitle, setAlbumTitle] = useState('');
  const [albumReleaseDate, setAlbumReleaseDate] = useState('');
  const [albumType, setAlbumType] = useState<'album' | 'single' | 'ep' | 'compilation'>('album');
  const [albumCoverArt, setAlbumCoverArt] = useState<string | null>(null);
  const [albumGenre, setAlbumGenre] = useState('');
  const [albumLabel, setAlbumLabel] = useState('');
  const [albumCopyright, setAlbumCopyright] = useState('');
  const [albumIsExplicit, setAlbumIsExplicit] = useState(false);
  const [albumErrors, setAlbumErrors] = useState<FormErrors>({});
  const [userAlbums, setUserAlbums] = useState<Album[]>([]);

  // Define load functions before useEffect hooks that use them
  const loadArtistProfile = useCallback(async () => {
    try {
      setLoading(true);
      const profile = await artistService.getMyArtistProfile();
      if (!profile) {
        toast.error('You need to register as an artist first');
        router.push('/artist/register');
        return;
      }
      
      // Check if uploads are disabled
      if (profile.uploadsDisabled) {
        setUploadsDisabled(true);
        toast.error('Uploads are disabled due to copyright strikes');
      } else {
        setUploadsDisabled(false);
      }
      setArtist(profile);
    } catch (error: any) {
      console.error('Failed to load artist profile:', error);
      toast.error(error?.message || 'Failed to load artist profile');
      router.back();
    } finally {
      setLoading(false);
    }
  }, [router]);

  const loadAlbums = useCallback(async () => {
    if (!artist) return;
    try {
      const result = await musicService.getArtistAlbums(artist.id);
      setUserAlbums(result.albums);
    } catch (error) {
      console.error('Failed to load albums:', error);
    }
  }, [artist]);

  useEffect(() => {
    loadArtistProfile();
  }, [loadArtistProfile]);

  useEffect(() => {
    if (artist) {
      loadAlbums();
    }
  }, [artist, loadAlbums]);

  const handlePickAudioFile = useCallback(() => {
    if (Platform.OS === 'web') {
      // Web: Create file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,.mp3,.flac,.ogg,.m4a,.wav';
      input.onchange = (e: any) => {
        const file = e.target.files?.[0];
        if (file) {
          // Use blob URL hook for proper lifecycle management
          setAudioBlobFile(file);
          // Store file object for upload - blob URL will be available via audioBlobUrl
          setAudioFile({
            uri: '', // Will be set by effect below
            name: file.name,
            type: file.type || 'audio/mpeg',
            file: file, // Store file object for upload
          });
          // Clear audio file error if present
          if (songErrors.audioFile) {
            setSongErrors((prev) => ({ ...prev, audioFile: undefined }));
          }
        }
      };
      input.click();
    } else {
      // Native: Show message (can be extended with expo-document-picker)
      Alert.alert(
        'Audio File Picker',
        'Audio file picker for native platforms coming soon. Please use the web version for now.',
        [{ text: 'OK' }]
      );
    }
  }, [setAudioBlobFile]);

  // Sync blob URL with audioFile state
  useEffect(() => {
    if (audioBlobUrl && audioFile && audioFile.uri !== audioBlobUrl) {
      setAudioFile((prev) => prev ? { ...prev, uri: audioBlobUrl } : null);
    }
  }, [audioBlobUrl]); // Only depend on audioBlobUrl to avoid infinite loop

  const validateSongForm = (): boolean => {
    const errors: FormErrors = {};
    if (!songTitle.trim()) {
      errors.title = 'Title is required';
    }
    if (!artist) {
      errors.artistId = 'Artist profile not found';
    }
    if (!audioFile) {
      errors.audioFile = 'Audio file is required';
    }
    const durationNum = parseFloat(songDuration);
    if (!songDuration || isNaN(durationNum) || durationNum <= 0) {
      errors.duration = 'Valid duration in seconds is required';
    }
    setSongErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateAlbumForm = (): boolean => {
    const errors: FormErrors = {};
    if (!albumTitle.trim()) {
      errors.albumTitle = 'Album title is required';
    }
    if (!albumReleaseDate) {
      errors.releaseDate = 'Release date is required';
    }
    if (!albumCoverArt) {
      errors.coverArt = 'Cover art is required';
    }
    if (!artist) {
      errors.artistId = 'Artist profile not found';
    }
    setAlbumErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleUploadSong = useCallback(async () => {
    if (!isAuthenticated || !artist) {
      toast.error('You must be logged in and have an artist profile');
      return;
    }

    if (uploadsDisabled) {
      toast.error('Uploads are disabled due to copyright strikes. Please contact support.');
      return;
    }

    if (!validateSongForm()) {
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const durationNum = parseFloat(songDuration);
      if (!audioFile) {
        toast.error('Audio file is required');
        return;
      }

      // Use blob URL if available (from hook), otherwise fall back to stored URI
      const fileForUpload = {
        uri: audioBlobUrl || audioFile.uri,
        name: audioFile.name,
        type: audioFile.type,
      };

      const track = await artistService.uploadTrack(
        fileForUpload,
        {
          title: songTitle.trim(),
          artistId: artist.id,
          albumId: songAlbumId || undefined,
          coverArt: songCoverArt || undefined,
          genre: songGenre ? [songGenre] : undefined,
          isExplicit: songIsExplicit,
          duration: durationNum,
        },
        (progress) => setUploadProgress(progress)
      );

      toast.success(`Track "${track.title}" uploaded successfully`);
      
      // Reset form
      setSongTitle('');
      setSongAlbumId('');
      setSongCoverArt(null);
      setSongGenre('');
      setSongIsExplicit(false);
      setSongDuration('');
      clearAudioBlob(); // Clean up blob URL
      setAudioFile(null);
      setUploadProgress(0);

      // Navigate to track or dashboard
      router.push(`/artist/dashboard`);
    } catch (error: any) {
      console.error('Failed to upload track:', error);
      toast.error(error?.message || 'Failed to upload track. Please try again.');
    } finally {
      setIsUploading(false);
    }
  }, [songTitle, songAlbumId, songCoverArt, songGenre, songIsExplicit, songDuration, audioFile, audioBlobUrl, artist, isAuthenticated, uploadsDisabled, router, clearAudioBlob]);

  const handleCreateAlbum = useCallback(async () => {
    if (!isAuthenticated || !artist) {
      toast.error('You must be logged in and have an artist profile');
      return;
    }

    if (uploadsDisabled) {
      toast.error('Uploads are disabled due to copyright strikes. Please contact support.');
      return;
    }

    if (!validateAlbumForm()) {
      return;
    }

    setIsUploading(true);

    try {
      const album = await artistService.createAlbum({
        title: albumTitle.trim(),
        artistId: artist.id,
        releaseDate: albumReleaseDate,
        coverArt: albumCoverArt!,
        genre: albumGenre ? [albumGenre] : undefined,
        type: albumType,
        label: albumLabel || undefined,
        copyright: albumCopyright || undefined,
        isExplicit: albumIsExplicit,
      });

      toast.success(`Album "${album.title}" created successfully`);
      
      // Reset form
      setAlbumTitle('');
      setAlbumReleaseDate('');
      setAlbumType('album');
      setAlbumCoverArt(null);
      setAlbumGenre('');
      setAlbumLabel('');
      setAlbumCopyright('');
      setAlbumIsExplicit(false);

      // Reload albums
      await loadAlbums();

      // Navigate to album or dashboard
      router.push(`/artist/dashboard`);
    } catch (error: any) {
      console.error('Failed to create album:', error);
      toast.error(error?.message || 'Failed to create album. Please try again.');
    } finally {
      setIsUploading(false);
    }
  }, [albumTitle, albumReleaseDate, albumType, albumCoverArt, albumGenre, albumLabel, albumCopyright, albumIsExplicit, artist, isAuthenticated, router]);

  const handleGoBack = useCallback(() => {
    if (!isUploading) {
      router.back();
    }
  }, [isUploading, router]);

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!artist) {
    return null;
  }

  return (
    <>
      <SEO title="Upload Music - Musico" description="Upload songs and create albums" />
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
            disabled={isUploading}
            style={styles.backButton}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={24}
              color={theme.colors.text}
            />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Upload Music
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Tabs */}
        <View style={[styles.tabs, { borderBottomColor: theme.colors.border }]}>
          <Pressable
            onPress={() => setActiveTab('song')}
            style={[
              styles.tab,
              activeTab === 'song' && {
                borderBottomWidth: 2,
                borderBottomColor: theme.colors.primary,
              },
            ]}
          >
            <Text
              style={[
                styles.tabText,
                {
                  color: activeTab === 'song' ? theme.colors.primary : theme.colors.textSecondary,
                  fontWeight: activeTab === 'song' ? 'bold' : 'normal',
                },
              ]}
            >
              Upload Song
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('album')}
            style={[
              styles.tab,
              activeTab === 'album' && {
                borderBottomWidth: 2,
                borderBottomColor: theme.colors.primary,
              },
            ]}
          >
            <Text
              style={[
                styles.tabText,
                {
                  color: activeTab === 'album' ? theme.colors.primary : theme.colors.textSecondary,
                  fontWeight: activeTab === 'album' ? 'bold' : 'normal',
                },
              ]}
            >
              Create Album
            </Text>
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
          {activeTab === 'song' ? (
            <>
              {/* Audio File Picker */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Audio File *
                </Text>
                <Pressable
                  onPress={handlePickAudioFile}
                  disabled={isUploading}
                  style={[
                    styles.filePickerButton,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      borderColor: songErrors.audioFile
                        ? theme.colors.error
                        : audioFile
                        ? theme.colors.primary
                        : theme.colors.border,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={audioFile ? 'check-circle' : 'upload'}
                    size={24}
                    color={audioFile ? theme.colors.primary : theme.colors.textSecondary}
                  />
                  <Text style={[styles.filePickerText, { color: theme.colors.text }]}>
                    {audioFile ? audioFile.name : 'Select Audio File'}
                  </Text>
                </Pressable>
                {songErrors.audioFile && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {songErrors.audioFile}
                  </Text>
                )}
                {isUploading && uploadProgress > 0 && (
                  <View style={styles.progressContainer}>
                    <View
                      style={[
                        styles.progressBar,
                        { backgroundColor: theme.colors.primary, width: `${uploadProgress}%` },
                      ]}
                    />
                    <Text style={[styles.progressText, { color: theme.colors.textSecondary }]}>
                      {Math.round(uploadProgress)}%
                    </Text>
                  </View>
                )}
              </View>

              {/* Title */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Title *
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      color: theme.colors.text,
                      borderColor: songErrors.title ? theme.colors.error : theme.colors.border,
                    },
                  ]}
                  placeholder="Song title"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={songTitle}
                  onChangeText={(text) => {
                    setSongTitle(text);
                    if (songErrors.title) {
                      setSongErrors((prev) => ({ ...prev, title: undefined }));
                    }
                  }}
                  maxLength={TITLE_MAX_LENGTH}
                  editable={!isUploading}
                />
                {songErrors.title && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {songErrors.title}
                  </Text>
                )}
              </View>

              {/* Duration */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Duration (seconds) *
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      color: theme.colors.text,
                      borderColor: songErrors.duration ? theme.colors.error : theme.colors.border,
                    },
                  ]}
                  placeholder="180"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={songDuration}
                  onChangeText={(text) => {
                    setSongDuration(text);
                    if (songErrors.duration) {
                      setSongErrors((prev) => ({ ...prev, duration: undefined }));
                    }
                  }}
                  keyboardType="numeric"
                  editable={!isUploading}
                />
                {songErrors.duration && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {songErrors.duration}
                  </Text>
                )}
              </View>

              {/* Album Selection */}
              {userAlbums.length > 0 && (
                <View style={styles.inputGroup}>
                  <Text style={[styles.label, { color: theme.colors.text }]}>
                    Album (optional)
                  </Text>
                  <View
                    style={[
                      styles.select,
                      {
                        backgroundColor: theme.colors.backgroundSecondary,
                        borderColor: theme.colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.selectText,
                        { color: songAlbumId ? theme.colors.text : theme.colors.textSecondary },
                      ]}
                    >
                      {songAlbumId
                        ? userAlbums.find((a) => a.id === songAlbumId)?.title || 'Select album'
                        : 'None'}
                    </Text>
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.albumChips}>
                    <Pressable
                      onPress={() => setSongAlbumId('')}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: !songAlbumId ? theme.colors.primary : theme.colors.backgroundSecondary,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: !songAlbumId ? '#FFFFFF' : theme.colors.text },
                        ]}
                      >
                        None
                      </Text>
                    </Pressable>
                    {userAlbums.map((album) => (
                      <Pressable
                        key={album.id}
                        onPress={() => setSongAlbumId(album.id)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor:
                              songAlbumId === album.id ? theme.colors.primary : theme.colors.backgroundSecondary,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            { color: songAlbumId === album.id ? '#FFFFFF' : theme.colors.text },
                          ]}
                        >
                          {album.title}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* Cover Art */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Cover Art (optional)
                </Text>
                <CoverArtPicker
                  value={songCoverArt || undefined}
                  onChange={setSongCoverArt}
                  size={150}
                  disabled={isUploading}
                />
              </View>

              {/* Genre */}
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
                  value={songGenre}
                  onChangeText={setSongGenre}
                  editable={!isUploading}
                />
              </View>

              {/* Explicit */}
              <View style={styles.inputGroup}>
                <Pressable
                  onPress={() => !isUploading && setSongIsExplicit(!songIsExplicit)}
                  style={styles.checkboxRow}
                >
                  <MaterialCommunityIcons
                    name={songIsExplicit ? 'checkbox-marked' : 'checkbox-blank-outline'}
                    size={24}
                    color={songIsExplicit ? theme.colors.primary : theme.colors.textSecondary}
                  />
                  <Text style={[styles.checkboxLabel, { color: theme.colors.text }]}>
                    Explicit content
                  </Text>
                </Pressable>
              </View>

              {/* Upload Disabled Warning */}
              {uploadsDisabled && (
                <View style={[styles.warningBanner, { 
                  backgroundColor: theme.colors.error + '20',
                  borderColor: theme.colors.error,
                }]}>
                  <MaterialCommunityIcons
                    name="alert-circle"
                    size={24}
                    color={theme.colors.error}
                  />
                  <View style={styles.warningContent}>
                    <Text style={[styles.warningTitle, { color: theme.colors.error }]}>
                      Uploads Disabled
                    </Text>
                    <Text style={[styles.warningText, { color: theme.colors.textSecondary }]}>
                      Your uploads have been disabled due to copyright strikes. Please contact support for assistance.
                    </Text>
                  </View>
                </View>
              )}

              {/* Upload Button */}
              <Pressable
                onPress={handleUploadSong}
                disabled={isUploading || uploadsDisabled || !songTitle.trim() || !audioFile || !songDuration}
                style={[
                  styles.submitButton,
                  {
                    backgroundColor:
                      isUploading || !songTitle.trim() || !audioFile || !songDuration
                        ? theme.colors.textSecondary
                        : theme.colors.primary,
                    opacity: isUploading || !songTitle.trim() || !audioFile || !songDuration ? 0.6 : 1,
                  },
                ]}
              >
                {isUploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.submitButtonText}>Upload Song</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              {/* Album Title */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Album Title *
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      color: theme.colors.text,
                      borderColor: albumErrors.albumTitle ? theme.colors.error : theme.colors.border,
                    },
                  ]}
                  placeholder="Album title"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={albumTitle}
                  onChangeText={(text) => {
                    setAlbumTitle(text);
                    if (albumErrors.albumTitle) {
                      setAlbumErrors((prev) => ({ ...prev, albumTitle: undefined }));
                    }
                  }}
                  maxLength={TITLE_MAX_LENGTH}
                  editable={!isUploading}
                />
                {albumErrors.albumTitle && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {albumErrors.albumTitle}
                  </Text>
                )}
              </View>

              {/* Release Date */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Release Date *
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      color: theme.colors.text,
                      borderColor: albumErrors.releaseDate ? theme.colors.error : theme.colors.border,
                    },
                  ]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={albumReleaseDate}
                  onChangeText={(text) => {
                    setAlbumReleaseDate(text);
                    if (albumErrors.releaseDate) {
                      setAlbumErrors((prev) => ({ ...prev, releaseDate: undefined }));
                    }
                  }}
                  editable={!isUploading}
                />
                {albumErrors.releaseDate && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {albumErrors.releaseDate}
                  </Text>
                )}
              </View>

              {/* Album Type */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Type *
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.albumChips}>
                  {(['album', 'single', 'ep', 'compilation'] as const).map((type) => (
                    <Pressable
                      key={type}
                      onPress={() => setAlbumType(type)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor:
                            albumType === type ? theme.colors.primary : theme.colors.backgroundSecondary,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: albumType === type ? '#FFFFFF' : theme.colors.text },
                        ]}
                      >
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              {/* Cover Art */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Cover Art *
                </Text>
                <CoverArtPicker
                  value={albumCoverArt || undefined}
                  onChange={(value) => {
                    setAlbumCoverArt(value);
                    if (albumErrors.coverArt) {
                      setAlbumErrors((prev) => ({ ...prev, coverArt: undefined }));
                    }
                  }}
                  size={200}
                  disabled={isUploading}
                />
                {albumErrors.coverArt && (
                  <Text style={[styles.errorText, { color: theme.colors.error }]}>
                    {albumErrors.coverArt}
                  </Text>
                )}
              </View>

              {/* Genre */}
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
                  value={albumGenre}
                  onChangeText={setAlbumGenre}
                  editable={!isUploading}
                />
              </View>

              {/* Label */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Label (optional)
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
                  placeholder="Record label"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={albumLabel}
                  onChangeText={setAlbumLabel}
                  editable={!isUploading}
                />
              </View>

              {/* Copyright */}
              <View style={styles.inputGroup}>
                <Text style={[styles.label, { color: theme.colors.text }]}>
                  Copyright (optional)
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
                  placeholder="© 2024 Label Name"
                  placeholderTextColor={theme.colors.textSecondary}
                  value={albumCopyright}
                  onChangeText={setAlbumCopyright}
                  editable={!isUploading}
                />
              </View>

              {/* Explicit */}
              <View style={styles.inputGroup}>
                <Pressable
                  onPress={() => !isUploading && setAlbumIsExplicit(!albumIsExplicit)}
                  style={styles.checkboxRow}
                >
                  <MaterialCommunityIcons
                    name={albumIsExplicit ? 'checkbox-marked' : 'checkbox-blank-outline'}
                    size={24}
                    color={albumIsExplicit ? theme.colors.primary : theme.colors.textSecondary}
                  />
                  <Text style={[styles.checkboxLabel, { color: theme.colors.text }]}>
                    Explicit content
                  </Text>
                </Pressable>
              </View>

              {/* Upload Disabled Warning */}
              {uploadsDisabled && (
                <View style={[styles.warningBanner, { 
                  backgroundColor: theme.colors.error + '20',
                  borderColor: theme.colors.error,
                }]}>
                  <MaterialCommunityIcons
                    name="alert-circle"
                    size={24}
                    color={theme.colors.error}
                  />
                  <View style={styles.warningContent}>
                    <Text style={[styles.warningTitle, { color: theme.colors.error }]}>
                      Uploads Disabled
                    </Text>
                    <Text style={[styles.warningText, { color: theme.colors.textSecondary }]}>
                      Your uploads have been disabled due to copyright strikes. Please contact support for assistance.
                    </Text>
                  </View>
                </View>
              )}

              {/* Create Button */}
              <Pressable
                onPress={handleCreateAlbum}
                disabled={isUploading || uploadsDisabled || !albumTitle.trim() || !albumReleaseDate || !albumCoverArt}
                style={[
                  styles.submitButton,
                  {
                    backgroundColor:
                      isUploading || !albumTitle.trim() || !albumReleaseDate || !albumCoverArt
                        ? theme.colors.textSecondary
                        : theme.colors.primary,
                    opacity: isUploading || !albumTitle.trim() || !albumReleaseDate || !albumCoverArt ? 0.6 : 1,
                  },
                ]}
              >
                {isUploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.submitButtonText}>Create Album</Text>
                )}
              </Pressable>
            </>
          )}
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
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 15,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
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
  filePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
  },
  filePickerText: {
    fontSize: 15,
    flex: 1,
  },
  progressContainer: {
    marginTop: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.1)',
    overflow: 'hidden',
    position: 'relative',
  },
  progressBar: {
    height: '100%',
    borderRadius: 4,
  },
  progressText: {
    position: 'absolute',
    right: 8,
    top: -20,
    fontSize: 12,
  },
  select: {
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  selectText: {
    fontSize: 15,
  },
  albumChips: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  checkboxLabel: {
    fontSize: 15,
  },
  errorText: {
    fontSize: 12,
    marginTop: -2,
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
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    marginBottom: 16,
  },
  warningContent: {
    flex: 1,
    gap: 4,
  },
  warningTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },
});

export default ArtistUploadScreen;

