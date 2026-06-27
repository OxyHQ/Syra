import { z } from 'zod';

/**
 * A People search-result / detail person — the global `Person` identity enriched
 * with the linked Oxy profile (avatar file id + displayName + username) when
 * `linkedOxyUserId` is set; RSS-only persons carry the external `img`.
 * Per-credit role/group/href are intentionally omitted (a person appears across
 * many shows with different roles).
 */
export const searchPersonSchema = z.object({
  personId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  username: z.string().optional(),
  /** Oxy avatar file id (resolve via the media resolver) when Oxy-linked. */
  oxyAvatar: z.string().optional(),
  /** External avatar URL (RSS persons only). */
  img: z.string().optional(),
  linkedOxyUserId: z.string().optional(),
  linkedArtistId: z.string().optional(),
  /** How many shows + episodes credit this person (detail endpoint / optional in search). */
  appearsInCount: z.number().optional(),
});
export type SearchPerson = z.infer<typeof searchPersonSchema>;
