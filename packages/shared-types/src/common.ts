/**
 * Shapes shared by every Syra DTO.
 *
 * ## A row's id is spelled `id`, and only `id`
 *
 * Thirteen DTOs across this package carried `_id: z.string().optional()`
 * alongside a required `id`. That pair dates from the Mongo era, when a handler
 * could return a Mongoose document whose id was `_id` — the optional `_id` was
 * the contract admitting it did not know which spelling it would get.
 *
 * Both halves of that are now gone. Every vertical is on Postgres, where the
 * primary key column is literally named `id`, and the serializers name their
 * output keys explicitly. So `_id` described a shape nothing produced: a field
 * clients could read, could not rely on, and would always find absent.
 *
 * It is removed rather than deprecated. Leaving it optional would be a compat
 * alias for a document type that no longer exists, and an optional field nobody
 * emits is indistinguishable to a client from one the server merely forgot —
 * which is worse than no field, because it invites a `?? _id` fallback that can
 * never fire.
 *
 * The rule this leaves: a DTO names a row's id `id`. If a new DTO needs a
 * SECOND id, it names what that id points AT (`trackId`, `coverArt`), never a
 * second spelling of its own.
 */

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
