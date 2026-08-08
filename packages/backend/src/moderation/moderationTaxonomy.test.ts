import { describe, expect, it } from 'bun:test';
import { SYRA_TAXONOMY } from './integration';
import { ReportCategory } from './types';

/**
 * Syra declares that it cannot attach evidence, and that declaration must not
 * be deletable in silence.
 *
 * `evidenceAttachmentsSupported: false` is one property of one object three
 * layers below a request. It changes no status, throws no error and fails no
 * other test — it travels to a jury, which uses it to answer
 * `insufficient_context` for the right reason instead of guessing that nothing
 * was withheld. Losing it degrades decision quality with nothing anywhere
 * saying so, which is exactly the shape that needs a gate rather than a comment.
 *
 * It has already been lost once: Syra carried it before adopting
 * `@oxyhq/crowdsource-app`, 0.5.0 had no hook for it, and the adoption dropped
 * it. This file is what stops that being possible a second time.
 */

describe('the taxonomy Syra hands the integration', () => {
  it('declares that evidence attachments are not supported', () => {
    expect(SYRA_TAXONOMY.metadata).toEqual({ evidenceAttachmentsSupported: false });
  });

  /**
   * The reserved names, asserted as an ABSENCE rather than trusted to the
   * package's merge order.
   *
   * `taxonomy.metadata` is merged UNDER `taxonomyVersion` and `categories`, so
   * an entry using either name is ignored — the package has its own test for
   * that. What that test cannot say is whether SYRA is trying: an adopter that
   * sets one is writing a line it believes has an effect and it has none.
   */
  it('does not try to set a key the package owns', () => {
    const metadata: Readonly<Record<string, unknown>> = SYRA_TAXONOMY.metadata ?? {};
    expect(Object.keys(metadata)).not.toContain('taxonomyVersion');
    expect(Object.keys(metadata)).not.toContain('categories');
  });

  /**
   * The floor. Without it, a taxonomy stripped to nothing but the metadata
   * above would satisfy every assertion in this file.
   */
  it('still maps a category to an allegation', () => {
    expect(SYRA_TAXONOMY.version).toBe('2026.07');
    expect(SYRA_TAXONOMY.allegationsFor([ReportCategory.SPAM])).toEqual(['integrity.spam']);
  });
});
