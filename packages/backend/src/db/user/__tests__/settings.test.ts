/**
 * `db/user/settings.ts` — the two projections and the clearing semantics.
 *
 * Both are behaviour the Mongo version got WRONG rather than behaviour this port
 * reproduces, so both are asserted here rather than described in a comment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { count } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { userSettings } from '../../schema/user';
import {
  VIEWER_VISIBLE_PRIVACY_FIELDS,
  ensureOwnUserSettings,
  ensureViewerVisiblePrivacy,
  updateUserSettings,
} from '../settings';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-owner-1';

/** How many `user_settings` rows exist — the "did a read write" check. */
async function settingsRowCount(): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(userSettings);
  return row.value;
}

describe('the two reads', () => {
  /**
   * `GET /api/profile/settings/:userId` answers for ANY account and used to
   * return the subject's whole settings document to whoever asked — muted words
   * and restricted accounts included. `ensureUserSettings` narrowed the
   * TypeScript type with `.lean<UserSettingsLean>()` and never projected: the
   * type said four fields and the object carried all of them, which is why
   * nothing caught it.
   *
   * **The defect was a PRESENCE, not an absence**, so the fixture writes the
   * sensitive fields first. An allowlist tested against a row that lacks them
   * passes identically whether or not the allowlist works. (That framing is from
   * PR #85, which fixed the same defect on `main` in parallel; the two were
   * reconciled onto its nine-field allowlist.)
   */
  it('returns the nine viewer-visible flags and nothing else', async () => {
    await updateUserSettings(OWNER, {
      privacyHiddenWords: ['spoilers', 'politics'],
      privacyRestrictedUsers: ['oxy-someone-else'],
      privacyProfileVisibility: 'followers_only',
      privacyHideLikeCounts: true,
      // Fields OUTSIDE `privacy` that the old shape also served to any caller.
      profileCustomizationDisplayName: 'Nate',
      interestsTags: ['jazz'],
      feedRecencyHalfLifeHours: 48,
    });

    const viewerView = await ensureViewerVisiblePrivacy(OWNER);

    // Exactly the allowlist — no more keys, and the real values, since a
    // projection returning the right keys with defaulted values would render
    // another account's profile wrongly.
    expect(Object.keys(viewerView).sort()).toEqual([...VIEWER_VISIBLE_PRIVACY_FIELDS].sort());
    expect(viewerView.profileVisibility).toBe('followers_only');
    expect(viewerView.hideLikeCounts).toBe(true);

    // Belt and braces: no secret VALUE appears anywhere in the response, under
    // any key — including the three fields outside `privacy` the wider shape
    // used to carry and no caller ever read.
    const serialised = JSON.stringify(viewerView);
    for (const secret of ['spoilers', 'politics', 'oxy-someone-else', 'Nate', 'jazz', '48']) {
      expect(serialised).not.toContain(secret);
    }
  });

  /**
   * Guards the LIST rather than the function: someone adding `hiddenWords` here
   * would reintroduce the leak with every behavioural assertion above still
   * green. Taken from PR #85, which had the same test for the same reason.
   */
  it('the allowlist itself excludes the two protected fields', () => {
    const allowed: readonly string[] = VIEWER_VISIBLE_PRIVACY_FIELDS;
    expect(allowed).not.toContain('hiddenWords');
    expect(allowed).not.toContain('restrictedUsers');
    expect(allowed).toHaveLength(9);
  });

  /**
   * The other half of the distinction, and the reason the fix is two reads
   * rather than one narrowed one: a projection that dropped the lists everywhere
   * would pass the assertion above while silently removing the owner's ability
   * to read back what they themselves muted.
   */
  it('returns them to the owner reading their own row', async () => {
    await updateUserSettings(OWNER, {
      privacyHiddenWords: ['spoilers', 'politics'],
      privacyRestrictedUsers: ['oxy-someone-else'],
    });

    const ownView = await ensureOwnUserSettings(OWNER);

    expect(ownView.privacy.hiddenWords).toEqual(['spoilers', 'politics']);
    expect(ownView.privacy.restrictedUsers).toEqual(['oxy-someone-else']);
  });
});

describe('null clears, undefined leaves alone', () => {
  /**
   * The defect this port fixes. `routes/profileSettings.ts` cleared five
   * optional fields by assigning `undefined` into a `$set`; **Mongoose 9 strips
   * undefined-valued keys out of an update**, so every one of those branches was
   * a no-op — the request succeeded, the response echoed the unchanged document,
   * and the field kept its old value. Measured on 9.7.4 against a real mongod,
   * with an explicit `null` as the control.
   *
   * Each field is set, then cleared, then a THIRD write touches something else
   * entirely — the sequencing matters, because a `set()` that dropped every key
   * would pass the "still cleared" half by never writing anything at all.
   */
  it('clears each of the five fields the Mongo handler could not', async () => {
    await updateUserSettings(OWNER, {
      appearancePrimaryColor: '#ff0000',
      profileCustomizationDisplayName: 'Nate',
      profileCustomizationCoverImage: 'https://cdn.example/cover.jpg',
      feedDiversityMaxConsecutiveSameAuthor: 4,
      feedQualityMinEngagementRate: 0.5,
    });

    const set = await ensureOwnUserSettings(OWNER);
    expect(set.appearance.primaryColor).toBe('#ff0000');
    expect(set.profileCustomization.displayName).toBe('Nate');
    expect(set.profileCustomization.coverImage).toBe('https://cdn.example/cover.jpg');
    expect(set.feedSettings.diversity.maxConsecutiveSameAuthor).toBe(4);
    expect(set.feedSettings.quality.minEngagementRate).toBe(0.5);

    const cleared = await updateUserSettings(OWNER, {
      appearancePrimaryColor: null,
      profileCustomizationDisplayName: null,
      profileCustomizationCoverImage: null,
      feedDiversityMaxConsecutiveSameAuthor: null,
      feedQualityMinEngagementRate: null,
    });

    expect(cleared.appearance.primaryColor).toBeUndefined();
    expect(cleared.profileCustomization.displayName).toBeUndefined();
    expect(cleared.profileCustomization.coverImage).toBeUndefined();
    expect(cleared.feedSettings.diversity.maxConsecutiveSameAuthor).toBeUndefined();
    expect(cleared.feedSettings.quality.minEngagementRate).toBeUndefined();
  });

  /**
   * The discriminating input for the OTHER direction. A patch that omits a key
   * must leave it alone — if `undefined` cleared, this would come back empty and
   * every "leave alone" caller in `buildSettingsPatch` would be silently
   * destructive.
   */
  it('leaves an omitted field untouched', async () => {
    await updateUserSettings(OWNER, {
      appearancePrimaryColor: '#00ff00',
      profileCustomizationDisplayName: 'Nate',
    });

    // Mentions neither field.
    const after = await updateUserSettings(OWNER, { privacyHideLikeCounts: true });

    expect(after.appearance.primaryColor).toBe('#00ff00');
    expect(after.profileCustomization.displayName).toBe('Nate');
    expect(after.privacy.hideLikeCounts).toBe(true);
  });
});

describe('reading another account does not write one', () => {
  /**
   * The Mongo route find-or-created, so `GET /settings/:userId` — which answers
   * for ANY id an authenticated caller names — was an unbounded write anybody
   * could drive: one row per id anyone ever asked about, keyed by a string they
   * chose. The viewer read needs nothing the row provides, so it no longer
   * creates one.
   */
  it('leaves no row behind for an account that has none', async () => {
    const before = await settingsRowCount();

    const privacy = await ensureViewerVisiblePrivacy('oxy-never-had-settings');

    expect(privacy.profileVisibility).toBe('public');
    expect(await settingsRowCount()).toBe(before);
  });

  /**
   * Pins {@link VIEWER_PRIVACY_DEFAULTS} to the DATABASE.
   *
   * That constant is a hand-written copy of nine column defaults — a second
   * source of truth, which is only safe with something that fails when the two
   * disagree. This inserts a bare row, reads it back through the real
   * projection, and compares: change a default in `schema/user.ts` without
   * changing the constant and this fails naming the field.
   */
  it('the no-row defaults equal what the database actually defaults to', async () => {
    const fromDefaults = await ensureViewerVisiblePrivacy('oxy-no-row-at-all');

    await getDb().insert(userSettings).values({ oxyUserId: 'oxy-real-row' });
    const fromDatabase = await ensureViewerVisiblePrivacy('oxy-real-row');

    expect(fromDefaults).toEqual(fromDatabase);
  });
});

describe('the row is created on first read', () => {
  it('gives an account with no row the schema defaults', async () => {
    const fresh = await ensureOwnUserSettings('oxy-never-seen');

    expect(fresh.appearance.themeMode).toBe('system');
    expect(fresh.privacy.profileVisibility).toBe('public');
    // Absent from the Mongo document until something wrote them; every Postgres
    // column carries its default, so the nested groups always render. A
    // deliberate widening — see `db/user/settings.ts`.
    expect(fresh.profileCustomization.coverPhotoEnabled).toBe(true);
    expect(fresh.interests.tags).toEqual([]);
    expect(fresh.feedSettings.recency.halfLifeHours).toBe(24);
  });

  it('is idempotent — a second ensure does not create a second row', async () => {
    const first = await ensureOwnUserSettings('oxy-twice');
    const second = await ensureOwnUserSettings('oxy-twice');

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });
});
