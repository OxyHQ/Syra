import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { api } from '@/utils/api';
import { resolveCatalogImageUrl } from '@/utils/catalogImages';
import { toast } from '@/lib/sonner';
import { cn } from '@/lib/utils';

interface CoverArtPickerProps {
  /** Selected cover art as an uploaded image id (MongoDB ObjectId). */
  value?: string | null;
  /** Called with the uploaded image id once a pick + upload succeeds. */
  onChange: (imageId: string | null) => void;
  size?: number;
  disabled?: boolean;
  error?: string;
}

/**
 * Universal cover-art picker (native + web, one codebase): `expo-image-picker`
 * selects an image, it is uploaded to `POST /images/upload` (multipart field
 * `image`), and the returned image id is reported via `onChange`. The preview
 * uses `expo-image` — the freshly-picked local URI while uploading, then the
 * resolved catalog URL for the stored id.
 */
export function CoverArtPicker({ value, onChange, size = 160, disabled = false, error }: CoverArtPickerProps) {
  const theme = useTheme();
  const [isUploading, setIsUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  const previewUri = localPreview ?? resolveCatalogImageUrl(value) ?? null;

  const pickAndUpload = useCallback(async () => {
    if (disabled || isUploading) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      toast.error('Photo library permission is required to choose cover art.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      allowsMultipleSelection: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    setLocalPreview(asset.uri);
    setIsUploading(true);
    try {
      const formData = new FormData();
      const fileName = asset.fileName ?? asset.uri.split('/').pop() ?? `cover-${Date.now()}.jpg`;
      const fileType = asset.mimeType ?? 'image/jpeg';

      if (Platform.OS === 'web') {
        const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
        formData.append('image', blob, fileName);
      } else {
        const rnFilePart = { uri: asset.uri, name: fileName, type: fileType } as unknown as Blob;
        formData.append('image', rnFilePart, fileName);
      }

      const response = await api.post<{ id?: string }>('/images/upload', formData);
      const imageId = response.data?.id;
      if (!imageId) {
        throw new Error('Image upload did not return an id');
      }
      onChange(imageId);
    } catch (uploadError) {
      setLocalPreview(null);
      toast.error(
        uploadError instanceof Error ? uploadError.message : 'Could not upload the image. Please try again.',
      );
    } finally {
      setIsUploading(false);
    }
  }, [disabled, isUploading, onChange]);

  return (
    <View>
      <Pressable
        onPress={pickAndUpload}
        disabled={disabled}
        style={{ width: size, height: size }}
        className={cn(
          'rounded-2xl border border-dashed items-center justify-center overflow-hidden bg-surface active:opacity-80',
          error ? 'border-destructive' : 'border-border',
          disabled ? 'opacity-50' : '',
        )}
      >
        {previewUri ? (
          <Image
            source={{ uri: previewUri }}
            style={{ width: size, height: size }}
            contentFit="cover"
            transition={150}
          />
        ) : (
          <View className="items-center justify-center gap-1.5 px-3">
            <MaterialCommunityIcons name="image-plus" size={size * 0.26} color={theme.colors.textSecondary} />
            <Text className="text-xs font-medium text-muted-foreground text-center">Add cover art</Text>
          </View>
        )}

        {isUploading ? (
          <View className="absolute inset-0 items-center justify-center bg-black/50 gap-2">
            <ActivityIndicator color="#fff" />
            <Text className="text-xs font-medium text-white">Uploading…</Text>
          </View>
        ) : null}
      </Pressable>
      {error ? <Text className="text-xs text-destructive mt-1">{error}</Text> : null}
    </View>
  );
}
