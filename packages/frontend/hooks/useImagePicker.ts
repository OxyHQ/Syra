import { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import { api } from '@/utils/api';

export interface ImagePickerResult {
  uri: string;
  width?: number;
  height?: number;
  type?: string;
  base64?: string;
}

export interface UseImagePickerOptions {
  allowsEditing?: boolean;
  quality?: number;
  aspect?: [number, number];
  maxWidth?: number;
  maxHeight?: number;
}

interface ReactNativeFormDataFile {
  uri: string;
  name: string;
  type: string;
}

interface ApiErrorResponse {
  response?: {
    data?: {
      message?: unknown;
    };
  };
  message?: unknown;
}

const getUploadErrorMessage = (error: unknown): string => {
  const apiError = error as ApiErrorResponse;
  const responseMessage = apiError.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage;
  }
  if (typeof apiError.message === 'string' && apiError.message.trim()) {
    return apiError.message;
  }
  return 'Failed to upload image. Please try again.';
};

/**
 * Hook for picking images from device
 * Supports both library and camera selection
 */
export function useImagePicker(options: UseImagePickerOptions = {}) {
  const [isUploading, setIsUploading] = useState(false);
  const {
    allowsEditing = true,
    quality = 0.8,
    aspect = [1, 1], // Square aspect ratio for playlist covers
  } = options;

  const pickImage = useCallback(async (source: 'library' | 'camera' = 'library'): Promise<ImagePickerResult | null> => {
    try {
      // Request permissions
      if (source === 'camera') {
        const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
        if (!cameraPermission.granted) {
          Alert.alert('Permission Required', 'Camera permission is required to take photos.');
          return null;
        }
      } else {
        const mediaLibraryPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!mediaLibraryPermission.granted) {
          Alert.alert('Permission Required', 'Media library permission is required to select images.');
          return null;
        }
      }

      // Launch image picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsEditing,
        aspect,
        quality,
        allowsMultipleSelection: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return null;
      }

      const asset = result.assets[0];
      return {
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        type: asset.type ?? undefined,
        base64: asset.base64 || undefined,
      };
    } catch (error) {
      console.error('Image picker error:', error);
      Alert.alert('Error', 'Failed to pick image. Please try again.');
      return null;
    }
  }, [allowsEditing, aspect, quality]);

  const takePhoto = useCallback(async (): Promise<ImagePickerResult | null> => {
    try {
      const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
      if (!cameraPermission.granted) {
        Alert.alert('Permission Required', 'Camera permission is required to take photos.');
        return null;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        allowsEditing,
        aspect,
        quality,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return null;
      }

      const asset = result.assets[0];
      return {
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        type: asset.type ?? undefined,
        base64: asset.base64 || undefined,
      };
    } catch (error) {
      console.error('Camera error:', error);
      Alert.alert('Error', 'Failed to take photo. Please try again.');
      return null;
    }
  }, [allowsEditing, aspect, quality]);

  /**
   * Upload image to backend and return image ID (MongoDB ObjectId string)
   * Uses authenticated client from oxyServices with current user's token
   */
  const uploadImage = useCallback(async (imageResult: ImagePickerResult): Promise<string | undefined> => {
    try {
      setIsUploading(true);
      
      const formData = new FormData();
      const fileName = imageResult.uri.split('/').pop() || `image-${Date.now()}.jpg`;
      
      // Expo 54 handles platform differences automatically
      const uploadFile: ReactNativeFormDataFile = {
        uri: imageResult.uri,
        name: fileName,
        type: imageResult.type || 'image/jpeg',
      };
      formData.append('image', uploadFile as unknown as Blob);

      // Upload to backend - the linked Syra API client includes the active Oxy token.
      // The app API wrapper returns an axios-style `{ data }` envelope.
      const response = await api.post<{ id: string }>('/images/upload', formData);

      return response.data.id;
    } catch (error: unknown) {
      console.error('Image upload error:', error);
      Alert.alert('Error', getUploadErrorMessage(error));
      return undefined;
    } finally {
      setIsUploading(false);
    }
  }, []);

  return {
    pickImage,
    takePhoto,
    uploadImage,
    isUploading,
  };
}
