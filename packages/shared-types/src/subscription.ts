import { z } from 'zod';
import { podcastSchema } from './podcast';

/** A single subscribed-show entry stored on the user's library. */
export const podcastSubscriptionSchema = z.object({
  podcastId: z.string(),
  subscribedAt: z.string(),
});
export type PodcastSubscription = z.infer<typeof podcastSubscriptionSchema>;

/** Subscription enriched with the resolved show + new-episode signals (list DTO). */
export const podcastSubscriptionWithShowSchema = z.object({
  podcast: podcastSchema,
  subscribedAt: z.string().optional(),
  newEpisodeCount: z.number().optional(),
  lastEpisodeAt: z.string().optional(),
});
export type PodcastSubscriptionWithShow = z.infer<typeof podcastSubscriptionWithShowSchema>;

export const podcastSubscriptionsSchema = z.object({
  subscriptions: z.array(podcastSubscriptionWithShowSchema),
  total: z.number(),
  oxyUserId: z.string(),
});
export type PodcastSubscriptions = z.infer<typeof podcastSubscriptionsSchema>;

export const subscribePodcastRequestSchema = z.object({
  podcastId: z.string(),
});
export type SubscribePodcastRequest = z.infer<typeof subscribePodcastRequestSchema>;

export const unsubscribePodcastRequestSchema = z.object({
  podcastId: z.string(),
});
export type UnsubscribePodcastRequest = z.infer<typeof unsubscribePodcastRequestSchema>;
