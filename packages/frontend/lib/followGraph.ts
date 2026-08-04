/**
 * Syra's corner of the Oxy follow graph.
 *
 * The user owns the follow and Syra borrows it: following an artist here is the
 * same relationship every other Oxy application sees, and switching it off in
 * Syra does not take it away from the user or from anywhere else. The design and
 * its scopes are documented in `OxyHQServices/docs/FOLLOWS.md`.
 *
 * This module holds the three facts an application must state exactly once — the
 * namespace, what following an artist MEANS, and how an artist is NAMED — so no
 * screen can answer any of them differently. Two screens disagreeing about the
 * URI would give one artist two target rows, and therefore every user two
 * parallel follows of the same artist.
 *
 * It deliberately knows nothing about React: registration is awaited from a
 * query function, never from a render.
 */

import { oxyServices } from '@/lib/oxyServices';

/** Claimed first-come and ours permanently; every Syra kind lives inside it. */
const FOLLOW_NAMESPACE = 'syra';

/** The one kind Syra registers today. */
export const ARTIST_FOLLOW_KIND = 'syra.artist';

/**
 * The origin an artist is NAMED by — a production literal on purpose, never
 * derived from `API_URL` or `window.location`.
 *
 * A target's URI is its identity, so an environment-dependent origin would make
 * a development build name the same artist `http://localhost:8120/p/<id>`,
 * register a second target row for them, and hand every developer a second
 * follow that production can never see. Distinct from `SEO.tsx`'s `SITE_ORIGIN`,
 * which is a *fallback* for when there is no `window` to read and is expected to
 * differ per deployment.
 */
const CANONICAL_ORIGIN = 'https://syra.fm';

/**
 * The canonical URI of an artist: their public profile URL.
 *
 * Always built from the ARTIST id, never from the id in the visited route.
 * `/p/:id` also resolves podcast people, and such a page follows its
 * `linkedArtistId` — keying on the visited id would give one artist two URIs.
 */
export function artistFollowUri(artistId: string): string {
  return `${CANONICAL_ORIGIN}/p/${artistId}`;
}

/**
 * The claim + kind registration, held as a promise so several artist controls on
 * one page register once between them.
 *
 * A rejection clears the memo so the next screen retries: a transient failure
 * here would otherwise become a permanent one for the rest of the session.
 */
let registration: Promise<void> | undefined;

async function register(): Promise<void> {
  await oxyServices.claimFollowNamespace(FOLLOW_NAMESPACE);
  await oxyServices.registerFollowKind({
    kind: ARTIST_FOLLOW_KIND,
    label: 'Artist',
    capabilities: {
      // Syra's own copy has always said Follow, not Subscribe — that verb
      // belongs to podcasts, which are a different kind and not registered here.
      verb: 'follow',
      // Who may see an artist's followers: a COUNT, never a list.
      //
      // Syra already publishes an artist's follower count on their public
      // profile, so answering the reverse question with a number states exactly
      // what the product already states. `public` would newly disclose WHO
      // listens to whom — a taste disclosure no listener opted into, and one
      // that cannot be taken back once other applications have read it.
      // `private` would contradict the count already on the page, and
      // `unavailable` would claim the question cannot be answered when it can.
      reverse: 'aggregate',
      // A Syra artist is a row in Syra's own catalogue, not a fediverse actor:
      // there is no remote server for a follow to be delivered to.
      federated: false,
    },
  });
}

/**
 * Claim the namespace and declare the artist kind, at most once per app run.
 *
 * Both calls are user-delegated — the capability is derived from the signed-in
 * user's session rather than from the application — so this cannot run at boot.
 * It is awaited lazily by the first artist screen that needs a target instead.
 * Both calls are idempotent server-side, so a second app instance registering
 * concurrently is not a conflict.
 */
export function ensureSyraFollowRegistry(): Promise<void> {
  registration ??= register().catch((error: unknown) => {
    registration = undefined;
    throw error;
  });
  return registration;
}

export interface ArtistFollowTargetInput {
  artistId: string;
  /** Display name for the shared snapshot other applications render. */
  name: string;
}

/**
 * Resolve — registering on first ask — the follow target for one artist, and
 * return its id.
 *
 * Idempotent on the URI, which is what makes two applications describing the
 * same artist arrive at ONE row, and therefore at one relationship per user
 * rather than one per app.
 */
export async function ensureArtistFollowTarget({
  artistId,
  name,
}: ArtistFollowTargetInput): Promise<string> {
  await ensureSyraFollowRegistry();
  const target = await oxyServices.ensureFollowTarget({
    uri: artistFollowUri(artistId),
    kind: ARTIST_FOLLOW_KIND,
    // Name only, and no `icon`, deliberately.
    //
    // Metadata is a snapshot every other application renders, and only the
    // PROVIDING application refreshes it — so anything that varies between two
    // Syra sessions overwrites what everyone else sees. Neither image Syra
    // holds survives that test. The artist's own cover is a Syra-hosted
    // catalogue image whose URL is built from the API origin (a `localhost` one
    // in development) and sits outside the Oxy media chokepoint, so no consumer
    // could resolve it as a file id either. The one Oxy file id in reach is the
    // avatar on a linked podcast PERSON row, and the profile controller sets it
    // on the person branch only — so the same artist would carry an icon when
    // reached at `/p/<personId>` and none at `/p/<artistId>`, making the shared
    // snapshot depend on which URL a viewer happened to open.
    //
    // A name alone is deterministic, and an icon can be added the day an artist
    // has an id the Oxy resolver understands.
    metadata: { name },
    // Syra's own id for the thing, so a later reverse lookup does not have to
    // parse it back out of the URI.
    providerReference: artistId,
  });
  return target.id;
}
