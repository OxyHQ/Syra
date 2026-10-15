import { z } from 'zod';

/** Opaque handles; the bound also limits request and log sizes. */
export const podcastIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => id.trim() === id);
export const publicPodcastCardsRequestSchema = z.strictObject({
  ids: z.array(podcastIdSchema).min(1).max(100),
});
export const publicPodcastCardSchema = z.strictObject({
  id: podcastIdSchema,
  title: z.string(),
  author: z.string().optional(),
  artworkUrl: z.url().optional(),
  showUrl: z.url(),
});
export const publicPodcastCardsResponseSchema = z.strictObject({
  items: z.array(publicPodcastCardSchema).max(100),
  unavailableIds: z.array(podcastIdSchema).max(100),
});
export const publicApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'bad_request',
      'validation_failed',
      'rate_limited',
      'internal_error',
      'service_unavailable',
    ]),
    message: z.string(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  }),
});
export type PublicPodcastCard = z.infer<typeof publicPodcastCardSchema>;
export type PublicPodcastCardsResponse = z.infer<typeof publicPodcastCardsResponseSchema>;
export type PublicApiErrorCode = z.infer<typeof publicApiErrorSchema>['error']['code'];

export const publicRoutes = [
  {
    method: 'post',
    path: '/api/podcasts/public-cards',
    request: publicPodcastCardsRequestSchema,
    responses: {
      200: publicPodcastCardsResponseSchema,
      400: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
  },
] as const;
export function publicOpenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'Syra public reference cards', version: '0.1.0' },
    paths: Object.fromEntries(
      publicRoutes.map((route) => [
        route.path,
        {
          [route.method]: {
            description:
              'Current active public shows, independent of caller identity. Maximum 100 opaque IDs; duplicates are deduplicated. Missing, private, unlisted and withdrawn shows are unavailable. No content is cached.',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: z.toJSONSchema(route.request) } },
            },
            responses: Object.fromEntries(
              Object.entries(route.responses).map(([status, schema]) => [
                status,
                {
                  description: status === '200' ? 'Current public cards' : 'Error',
                  content: { 'application/json': { schema: z.toJSONSchema(schema) } },
                },
              ]),
            ),
          },
        },
      ]),
    ),
  };
}
