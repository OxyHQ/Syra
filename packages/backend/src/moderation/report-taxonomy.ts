import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import { ReportCategory } from '../models/Report';

/**
 * Syra's report categories, translated into CrowdSource's universal taxonomy.
 *
 * The categories on the left are what a reporter picked in Syra's UI. The codes on
 * the right are ALLEGATIONS (§6.2) — what is claimed, never what is true. A jury
 * classifies the material itself and may confirm a different code entirely.
 *
 * ## Why this is versioned
 *
 * §6.4 requires every decision to record the policy version it was decided under,
 * and this mapping is upstream of that: change what `spam` means and two reports
 * filed a month apart are no longer the same allegation.
 * {@link REPORT_TAXONOMY_VERSION} is stamped into the report metadata so a case
 * can always be read back against the mapping that produced it. Bump it in the
 * same change that alters a row.
 *
 * ## There is no copyright row, and there must never be one
 *
 * The obvious gap on a music platform is copyright, and it is deliberate on both
 * sides. `ReportCategory` has no `copyright` value, and the universal taxonomy has
 * no code that could receive one — forty codes across eleven families and not a
 * single infringement code; `commerce.counterfeit` is about goods.
 *
 * That is the contract declining the question rather than overlooking it. DMCA
 * carries statutory process, counter-notice and safe-harbour consequences, and
 * §7.5 routes material with legal weight to specialists rather than to a randomly
 * drawn jury. Syra already has that pipeline — `CopyrightReport` plus
 * `strikeService` — and it stays separate. Adding a row here would let a community
 * vote produce something that looks like a strike but carries none of the process
 * a strike legally requires.
 *
 * ## The row worth arguing about
 *
 * **`violence` maps to `violence.graphic`, not `violence.threat`.** On an audio
 * platform the usual complaint is about depiction — a track, a title, a room
 * description — rather than about a threat directed at someone. `violence.threat`
 * is a much stronger claim about intent toward a person, and a jury that finds one
 * will say so; alleging it by default would put words in the reporter's mouth. A
 * threat aimed at a person is harassment in Syra's UI, and
 * `harassment.targeted_abuse` is where that lands.
 */
export const REPORT_TAXONOMY_VERSION = '2026.07';

const CATEGORY_TO_ALLEGATION: Readonly<Record<ReportCategory, TaxonomyCode>> =
  Object.freeze({
    [ReportCategory.SPAM]: 'integrity.spam',
    [ReportCategory.HARASSMENT]: 'harassment.targeted_abuse',
    [ReportCategory.HATE_SPEECH]: 'hate.protected_targeting',
    [ReportCategory.EXPLICIT_CONTENT]: 'sexual_content.explicit_activity',
    [ReportCategory.IMPERSONATION]: 'integrity.impersonation',
    [ReportCategory.VIOLENCE]: 'violence.graphic',
    [ReportCategory.OTHER]: 'other.unclassifiable',
  });

/**
 * The allegation codes for a report's categories, deduplicated and ORDERED.
 *
 * Order is not cosmetic. Ingress fingerprints the whole envelope to detect §10.5's
 * "same external id, different body", so a list whose order depended on how a
 * client happened to send its categories would turn a legitimate outbox retry into
 * a permanent 409 — days later, as a report silently stuck in a queue.
 */
export function allegationsForCategories(
  categories: readonly ReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_ALLEGATION[category];
    // A category the map does not cover cannot silently become nothing: a report
    // with no allegation is not a report.
    codes.add(code ?? 'other.unclassifiable');
  }
  return Array.from(codes).sort();
}
