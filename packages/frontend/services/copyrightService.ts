import { api, publicClient } from '@/utils/api';

export interface ReportCopyrightViolationRequest {
  trackId: string;
  reason: string;
}

export interface ReportCopyrightViolationResponse {
  id: string;
  trackId: string;
  status: string;
  message: string;
}

/**
 * Copyright API service
 * Handles copyright violation reporting
 */
export const copyrightService = {
  /**
   * Report a copyright violation (public endpoint, no auth required)
   * Uses publicClient to ensure it works without authentication
   */
  async reportCopyrightViolation(
    data: ReportCopyrightViolationRequest,
  ): Promise<ReportCopyrightViolationResponse> {
    // Use publicClient for public endpoint (no auth required)
    const response = await publicClient.post<ReportCopyrightViolationResponse>(
      '/copyright/report',
      data,
    );
    return response.data;
  },
};
