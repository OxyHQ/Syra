import { describe, it, expect } from 'bun:test';
import {
  SubjectTypeSchema,
  TaxonomyCodeSchema,
  UNIVERSAL_TAXONOMY_CODES,
} from '@oxyhq/crowdsource-contracts';
import { deliverableTypes, subjectProviderFor } from './subjects/registry';
import { allegationsForCategories, REPORT_TAXONOMY_VERSION } from './report-taxonomy';
import { ReportCategory, ReportedType } from '../models/Report';

describe('subject registry', () => {
  it('delivers exactly the five nouns Syra can describe', () => {
    expect(deliverableTypes().sort()).toEqual([
      'artist',
      'house',
      'playlist',
      'room',
      'track',
    ]);
  });

  it('declares §5.4-valid subject types', () => {
    for (const reportedType of deliverableTypes()) {
      const provider = subjectProviderFor(reportedType);
      expect(provider).toBeDefined();
      expect(SubjectTypeSchema.safeParse(provider?.subjectType).success).toBe(true);
    }
  });

  /**
   * A room IS reportable, and that is the correction worth pinning: `Room` is a
   * durable document whose title, description, topic and stream fields are all
   * host-authored, so §5.6 has something to pin and a jury has something to
   * answer. What the provider withholds — the conversation, the participant list
   * and the recording — is asserted in the provider's own tests.
   */
  it('reports a room, with the host as its author', () => {
    expect(subjectProviderFor(ReportedType.ROOM)?.subjectType).toBe('custom.syra.room');
  });

  /**
   * An artist has a Syra-side profile; a listener does not. That difference is
   * the whole reason one is deliverable and the other is not — Oxy owns identity,
   * and there is nothing Syra could snapshot for a plain account.
   */
  it('reports an artist profile but not a listener account', () => {
    expect(subjectProviderFor(ReportedType.ARTIST)?.subjectType).toBe('identity.profile');
    expect(subjectProviderFor(ReportedType.USER)).toBeUndefined();
  });

  /**
   * Mirrored from external RSS: the publisher is not a Syra user, has no Oxy
   * identity, and would never learn a jury had judged them. Accepted so the
   * report surface keeps working, never delivered.
   */
  it('accepts a mirrored podcast and episode but delivers neither', () => {
    for (const type of [ReportedType.PODCAST, ReportedType.EPISODE]) {
      expect(Object.values(ReportedType)).toContain(type);
      expect(subjectProviderFor(type)).toBeUndefined();
      expect(deliverableTypes()).not.toContain(type);
    }
  });

  it('answers undefined for a type it has never heard of', () => {
    expect(subjectProviderFor('not_a_type')).toBeUndefined();
  });
});

describe('report taxonomy', () => {
  it('emits a valid universal code for every category Syra offers', () => {
    for (const category of Object.values(ReportCategory)) {
      const codes = allegationsForCategories([category]);
      expect(codes).toHaveLength(1);
      expect(TaxonomyCodeSchema.safeParse(codes[0]).success).toBe(true);
    }
  });

  /**
   * The copyright boundary, asserted from BOTH sides.
   *
   * Syra offers no `copyright` category, and the universal taxonomy offers no code
   * that could receive one — which is the contract declining the question rather
   * than overlooking it. DMCA carries statutory process and lives in
   * `CopyrightReport` + `strikeService`; a community vote must never be able to
   * produce something that looks like a strike but carries none of the process one
   * legally requires.
   *
   * If a future contracts release ever adds an infringement code, this test fails
   * and the decision gets made deliberately instead of by import.
   */
  it('has no copyright category, because the taxonomy has no code for one', () => {
    expect(Object.values(ReportCategory)).not.toContain('copyright' as ReportCategory);
    const infringementCodes = UNIVERSAL_TAXONOMY_CODES.filter((code) =>
      /copyright|infring|intellectual|dmca/i.test(code),
    );
    expect(infringementCodes).toEqual([]);
  });

  /**
   * On an audio platform the usual complaint is about depiction, not about a
   * threat aimed at a person. `violence.threat` is a much stronger claim about
   * intent, and alleging it by default would put words in the reporter's mouth.
   */
  it('reads a violence report as depiction, not as a threat', () => {
    expect(allegationsForCategories([ReportCategory.VIOLENCE])).toEqual(['violence.graphic']);
  });

  it('maps impersonation to the integrity code', () => {
    expect(allegationsForCategories([ReportCategory.IMPERSONATION])).toEqual([
      'integrity.impersonation',
    ]);
  });

  /**
   * Order is not cosmetic. Ingress fingerprints the whole envelope to detect
   * §10.5's "same external id, different body", so a list whose order followed the
   * client's would turn a legitimate outbox retry into a permanent 409.
   */
  it('produces the same bytes whatever order the client sent', () => {
    const a = allegationsForCategories([
      ReportCategory.SPAM,
      ReportCategory.HARASSMENT,
      ReportCategory.VIOLENCE,
    ]);
    const b = allegationsForCategories([
      ReportCategory.VIOLENCE,
      ReportCategory.HARASSMENT,
      ReportCategory.SPAM,
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('deduplicates and never yields an empty list', () => {
    expect(allegationsForCategories([ReportCategory.SPAM, ReportCategory.SPAM])).toHaveLength(1);
    expect(allegationsForCategories([ReportCategory.OTHER]).length).toBeGreaterThan(0);
  });

  it('carries a version so a case can be read back against this mapping', () => {
    expect(REPORT_TAXONOMY_VERSION).toMatch(/^\d{4}\.\d{2}$/);
  });
});
