import { Platform } from 'react-native';
import axios from 'axios';
import type { OxyServices } from '@oxyhq/core';
import { API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
};

// The single authenticated Syra API client. `createLinkedClient` re-syncs the
// bearer token from the owning OxyServices instance before each request, so the
// studio never hand-rolls Authorization headers, refresh, or CSRF plumbing.
const syraApiClient = oxyServices.createLinkedClient({ baseURL: API_CONFIG.baseURL });
const authenticatedClient: ReturnType<OxyServices['getClient']> = syraApiClient.client;

export interface ApiRequestOptions {
  cache?: boolean;
  cacheTTL?: number;
  deduplicate?: boolean;
  retry?: boolean;
  maxRetries?: number;
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// Public API client (no authentication required)
const publicClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// API methods using authenticatedClient (the OxyServices HttpService).
// HttpService request methods return the parsed response body directly
// (typed Promise<T>), NOT an axios-style { data } envelope — so the resolved
// value IS the data.
export const api = {
  async get<T = unknown>(
    endpoint: string,
    params?: Record<string, unknown>,
    options?: ApiRequestOptions,
  ): Promise<{ data: T }> {
    const data = await authenticatedClient.get<T>(endpoint, { params, ...options });
    return { data };
  },

  async post<T = unknown>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<{ data: T }> {
    const data = await authenticatedClient.post<T>(endpoint, body, options);
    return { data };
  },

  async put<T = unknown>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<{ data: T }> {
    const data = await authenticatedClient.put<T>(endpoint, body, options);
    return { data };
  },

  async delete<T = unknown>(endpoint: string, options?: ApiRequestOptions): Promise<{ data: T }> {
    const data = await authenticatedClient.delete<T>(endpoint, options);
    return { data };
  },

  async patch<T = unknown>(endpoint: string, body?: unknown, options?: ApiRequestOptions): Promise<{ data: T }> {
    const data = await authenticatedClient.patch<T>(endpoint, body, options);
    return { data };
  },
};

export class ApiError extends Error {
  constructor(message: string, public status?: number, public response?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
  }
  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/**
 * Pulls the backend's `invalidIds` array out of a 400 error body (returned when
 * a hosts/guests submission contains an id that isn't a real Oxy user). Reads
 * both the linked-client (`error.data`) and axios-style (`error.response.data`)
 * shapes.
 */
export function extractInvalidIds(error: unknown): string[] | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidates: unknown[] = [
    (error as { response?: { data?: unknown } }).response?.data,
    (error as { data?: unknown }).data,
    error,
  ];
  for (const body of candidates) {
    if (body && typeof body === 'object' && 'invalidIds' in body) {
      const ids = (body as { invalidIds?: unknown }).invalidIds;
      if (Array.isArray(ids)) {
        return ids.filter((id): id is string => typeof id === 'string');
      }
    }
  }
  return undefined;
}

export function isUnauthorizedError(error: unknown): boolean {
  return getHttpStatus(error) === 401;
}

export function isNotFoundError(error: unknown): boolean {
  return getHttpStatus(error) === 404;
}

export function webAlert(
  title: string,
  message: string,
  buttons?: Array<{ text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void }>,
): void {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const result = window.confirm(`${title}\n\n${message}`);
      if (result) {
        const confirmButton = buttons.find((btn) => btn.style !== 'cancel');
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find((btn) => btn.style === 'cancel');
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

// Public API methods (no authentication required)
export const publicApi = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await publicClient.get(endpoint, { params });
    return { data: response.data };
  },
};

export { API_CONFIG, authenticatedClient, publicClient };
