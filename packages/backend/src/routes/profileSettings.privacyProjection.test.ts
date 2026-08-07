import { describe, expect, it } from 'bun:test';
import {
  VIEWER_VISIBLE_PRIVACY_FIELDS,
  viewerVisiblePrivacy,
} from './profileSettings';

/**
 * `GET /api/profile/settings/:userId` is mounted behind `requireAuth` and takes
 * the account id from the URL, so before this projection it served ANY account's
 * full settings document to ANY authenticated caller — including
 * `privacy.hiddenWords` (the mute list) and `privacy.restrictedUsers` (the block
 * list).
 *
 * `ensureUserSettings` returns `.lean<UserSettingsLean>()`, which CASTS without
 * projecting, so the TypeScript type said those fields were absent while the
 * runtime document carried them. Two guards that each looked sufficient, both
 * inert on the same path.
 *
 * **The defect was a PRESENCE, not an absence**, so every fixture here carries
 * the sensitive fields. An allowlist tested against a document that lacks them
 * passes identically whether or not the allowlist works.
 */
const FULL_PRIVACY = {
  profileVisibility: 'followers_only',
  showContactInfo: false,
  allowTags: true,
  allowMentions: false,
  showOnlineStatus: true,
  hideLikeCounts: true,
  hideShareCounts: false,
  hideReplyCounts: true,
  hideSaveCounts: false,
  hiddenWords: ['spoiler', 'politics'],
  restrictedUsers: ['oxy-user-blocked-1', 'oxy-user-blocked-2'],
};

describe('viewer-visible privacy projection', () => {
  it('never returns the mute list or the block list', () => {
    const projected = viewerVisiblePrivacy(FULL_PRIVACY);

    expect(projected).not.toHaveProperty('hiddenWords');
    expect(projected).not.toHaveProperty('restrictedUsers');
    // Belt and braces: no VALUE from either list may appear under any key.
    const serialised = JSON.stringify(projected);
    for (const secret of [...FULL_PRIVACY.hiddenWords, ...FULL_PRIVACY.restrictedUsers]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('returns every viewer-visible field, with its real value', () => {
    const projected = viewerVisiblePrivacy(FULL_PRIVACY);

    // Values, not just presence — a projection that returned the right KEYS with
    // wrong or defaulted values would render another account's profile wrongly.
    expect(projected).toEqual({
      profileVisibility: 'followers_only',
      showContactInfo: false,
      allowTags: true,
      allowMentions: false,
      showOnlineStatus: true,
      hideLikeCounts: true,
      hideShareCounts: false,
      hideReplyCounts: true,
      hideSaveCounts: false,
    });
  });

  it('carries no key outside the allowlist, whatever the document holds', () => {
    // The document a route hands this function is the WHOLE settings row, not a
    // privacy subdocument — `.lean()` does not project, so anything added to the
    // model tomorrow arrives here too.
    const projected = viewerVisiblePrivacy({
      ...FULL_PRIVACY,
      someFieldAddedLater: 'must not leak',
      notifications: { email: true },
    });

    expect(Object.keys(projected).sort()).toEqual(
      [...VIEWER_VISIBLE_PRIVACY_FIELDS].sort(),
    );
  });

  it('omits absent fields rather than emitting undefined', () => {
    // A fresh account's document has defaults for some fields and nothing for
    // others; emitting `undefined` keys would make the response shape depend on
    // account age.
    const projected = viewerVisiblePrivacy({ profileVisibility: 'public' });

    expect(projected).toEqual({ profileVisibility: 'public' });
    expect(Object.keys(projected)).not.toContain('showContactInfo');
  });

  it('tolerates a missing privacy subdocument', () => {
    expect(viewerVisiblePrivacy(undefined)).toEqual({});
    expect(viewerVisiblePrivacy(null)).toEqual({});
  });

  it('the allowlist itself excludes the two protected fields', () => {
    // Guards the list rather than the function: someone adding `hiddenWords`
    // here would reintroduce the leak with every behavioural test still green.
    const allowed: readonly string[] = VIEWER_VISIBLE_PRIVACY_FIELDS;
    expect(allowed).not.toContain('hiddenWords');
    expect(allowed).not.toContain('restrictedUsers');
  });
});
