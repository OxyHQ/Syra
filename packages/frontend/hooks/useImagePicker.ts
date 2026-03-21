import { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import { API_URL } from '@/config';

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
        type: asset.type,
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
        type: asset.type,
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
      
      // Create OxyServices instance configured for Syra API
      // It uses the same token storage, so authentication is automatic
      const { OxyServices } = await import('@oxyhq/services');
      const api = new OxyServices({ baseURL: API_URL }).getClient();
      
      const formData = new FormData();
      const fileName = imageResult.uri.split('/').pop() || `image-${Date.now()}.jpg`;
      
      // Expo 54 handles platform differences automatically
      formData.append('image', {
        uri: imageResult.uri,
        name: fileName,
        type: imageResult.type || 'image/jpeg',
      } as any);

      // Upload to backend - authenticated client automatically includes auth token
      const response = await api.post<{ id: string }>('/images/upload', formData);

      return response.data.id;
    } catch (error: any) {
      console.error('Image upload error:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to upload image. Please try again.';
      Alert.alert('Error', errorMessage);
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

