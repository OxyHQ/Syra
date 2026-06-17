import { z } from 'zod';

export const coordinatesSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type Coordinates = z.infer<typeof coordinatesSchema>;

export const geoJSONPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
  address: z.string().optional(),
});
export type GeoJSONPoint = z.infer<typeof geoJSONPointSchema>;

export const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  pages: z.number(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    message: z.string().optional(),
    error: z.string().optional(),
    data: dataSchema.optional(),
  });
export type ApiResponse<T = unknown> = {
  success: boolean;
  message?: string;
  error?: string;
  data?: T;
};

export const timestampsSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Timestamps = z.infer<typeof timestampsSchema>;

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
