import { OxyServices } from '@oxyhq/core';
import { Platform } from 'react-native';
import axios from 'axios';
import { API_URL } from '@/config';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
};

// Initialize OxyServices - if it automatically adds /api prefix, we don't need it in baseURL
const oxyServices = new OxyServices({ baseURL: API_CONFIG.baseURL });
// `@oxyhq/core` does not export the HttpService type by name, so derive an
// explicit, nameable annotation from the public `getClient` signature. Without
// it, TypeScript cannot name the inferred export type (TS2883).
const authenticatedClient: ReturnType<OxyServices['getClient']> = oxyServices.getClient();

// Public API client (no authentication required)
const publicClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// API methods using authenticatedClient (the OxyServices HttpService).
// HttpService request methods return the parsed response body directly
// (typed Promise<T>), NOT an axios-style { data } envelope — so the
// resolved value IS the data.
export const api = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const data = await authenticatedClient.get<T>(endpoint, { params });
    return { data };
  },

  async post<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const data = await authenticatedClient.post<T>(endpoint, body);
    return { data };
  },

  async put<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const data = await authenticatedClient.put<T>(endpoint, body);
    return { data };
  },

  async delete<T = any>(endpoint: string): Promise<{ data: T }> {
    const data = await authenticatedClient.delete<T>(endpoint);
    return { data };
  },

  async patch<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const data = await authenticatedClient.patch<T>(endpoint, body);
    return { data };
  },
};

export class ApiError extends Error {
  constructor(message: string, public status?: number, public response?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

// Error checking utilities
export function isUnauthorizedError(error: any): boolean {
  return error?.response?.status === 401 || error?.status === 401;
}

export function isNotFoundError(error: any): boolean {
  return error?.response?.status === 404 || error?.status === 404;
}

export function isAuthError(error: any): boolean {
  const status = error?.response?.status || error?.status;
  return status === 401 || status === 403;
}

export function webAlert(
  title: string,
  message: string,
  buttons?: Array<{ text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void }>
) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const result = window.confirm(`${title}\n\n${message}`);
      if (result) {
        const confirmButton = buttons.find(btn => btn.style !== 'cancel');
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find(btn => btn.style === 'cancel');
        cancelButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
}

export const healthApi = {
  async checkHealth() {
    const response = await api.get('/api/health');
    return response.data;
  },
};

// Public API methods (no authentication required)
export const publicApi = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const response = await publicClient.get(endpoint, { params });
    return { data: response.data };
  },
};

/**
 * Get API origin, ensuring correct port for localhost (3000)
 * This is critical: backend API runs on port 3000, regardless of frontend dev server port
 */
export function getApiOrigin(): string {
  try {
    const apiBaseUrlObj = new URL(API_CONFIG.baseURL);
    // Force port 3000 for localhost API (development)
    if (apiBaseUrlObj.hostname === 'localhost' || apiBaseUrlObj.hostname === '127.0.0.1') {
      return `${apiBaseUrlObj.protocol}//${apiBaseUrlObj.hostname}:3000`;
    }
    // Production or other environments - use origin as-is
    return apiBaseUrlObj.origin;
  } catch {
    // Fallback: extract origin manually, defaulting to port 3000 for localhost
    const match = API_CONFIG.baseURL.match(/^(https?:\/\/)([^\/:]+)(:\d+)?/);
    if (match) {
      const [, protocol, hostname] = match;
      return (hostname === 'localhost' || hostname === '127.0.0.1')
        ? `${protocol}${hostname}:3000`
        : match[0] || `${protocol}${hostname}`;
    }
    return 'http://localhost:3000';
  }
}

export { API_CONFIG, oxyServices, authenticatedClient, publicClient };
