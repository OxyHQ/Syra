import { SYRA_SUBJECT_PROVIDERS } from './providers';
import type { ModerationSubjectProvider } from './types';

/**
 * Every noun Syra can send for community review, and the §5.4 type each one is.
 *
 * Adding a subject type is one provider plus one entry. Nothing else in the
 * integration knows what a track is — not the outbox, not the delivery worker,
 * not the webhook receiver, not the enforcement service.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A reported type
 * WITHOUT one is still accepted by `POST /reports` and still stored — it simply
 * never leaves. Making the registry an admission gate would break an
 * application's existing report surfaces on the day it adopts CrowdSource;
 * incremental adoption, one subject type at a time, is what makes this copyable.
 *
 * ## A room IS reportable — for what its host wrote, not for what was said
 *
 * The assumption worth correcting, because it is the one a reader arrives with: a
 * live audio room is not too ephemeral to pin. `Room` is a durable document whose
 * `title`, `description`, `topic`, `tags` and stream fields are all
 * HOST-AUTHORED, and a room titled with a slur is answerable on its face. So it
 * has a provider and the host is its author.
 *
 * What has no provider is the CONVERSATION. `participants` and `speakers` change
 * every few seconds, so pinning either would name people who merely listened and
 * would describe a roster that was never true of the session. And the recording —
 * which does exist, by default, for months — is withheld on both a privacy
 * argument and a mechanical one; `subjects/providers.ts` sets both out in full.
 *
 * ## Copyright is not here, and must never be added
 *
 * `CopyrightReport` plus `strikeService` already handle DMCA, and they stay
 * separate. The universal taxonomy contains no copyright, infringement or IP code
 * at all — forty codes across eleven families, and the nearest,
 * `commerce.counterfeit`, is about goods. That absence is the contract declining
 * the question: DMCA carries statutory process, counter-notice and safe-harbour
 * consequences, and §7.5 sends material with legal weight to specialists rather
 * than to a randomly drawn jury. A community vote must never be able to produce
 * something that looks like a strike but carries none of the process one legally
 * requires.
 *
 * ## Why a podcast has no provider
 *
 * Syra podcasts are MIRRORED from external RSS. The publisher is a third party
 * who is not a Syra user, has no Oxy identity, and would never learn that a jury
 * had judged them. `applicationId` comes off the credential, so a case would open
 * in SYRA's tenant naming an actor Syra cannot act against beyond delisting its
 * own mirror — and if the origin platform ever reported the same show under its
 * own credential, §7.3's dedup key differs by tenant, so one show would get two
 * cases and two juries.
 *
 * That is the same cross-application hand-off question the plan has not answered
 * elsewhere, so the report stays local until it does. Delisting a mirror is still
 * available to a human through the existing admin path; it simply is not a case.
 *
 * ## Why a listener has no provider
 *
 * Oxy owns identity, and a plain Syra listener has no Syra-side profile to
 * snapshot — there is nothing §5.6 could pin. An ARTIST does have one, which is
 * why `artist` is deliverable and `user` is not.
 */

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  SYRA_SUBJECT_PROVIDERS.map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment. Intake asks
 * before queueing a delivery and the snapshot builder asks again when it builds
 * one; a type this returns `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can pin the set. The difference between a delivered type and a
 * local-only one is invisible in a 201, so registering a provider — or forgetting
 * to — is a change no response body would reveal.
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}
