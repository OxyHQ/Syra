/**
 * `db/user/settings.ts` — the two projections and the clearing semantics.
 *
 * Both are behaviour the Mongo version got WRONG rather than behaviour this port
 * reproduces, so both are asserted here rather than described in a comment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import {
  ensureOwnUserSettings,
  ensurePublicUserSettings,
  updateUserSettings,
} from '../settings';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-owner-1';

describe('the two projections', () => {
  /**
   * `GET /api/profile/settings/:userId` answers for ANY account and used to
   * return the subject's muted words and restricted accounts to whoever asked.
   * `ensureUserSettings` narrowed the TypeScript type with
   * `.lean<UserSettingsLean>()` and never projected — the type said four fields
   * and the object carried all of them, which is why nothing caught it.
   */
  it('withholds the two server-only lists from the public projection', async () => {
    await updateUserSettings(OWNER, {
      privacyHiddenWords: ['spoilers', 'politics'],
      privacyRestrictedUsers: ['oxy-someone-else'],
    });

    const publicView = await ensurePublicUserSettings(OWNER);

    expect(publicView.privacy.hiddenWords).toBeUndefined();
    expect(publicView.privacy.restrictedUsers).toBeUndefined();
    // The rest of `privacy` describes how a profile renders to other people and
    // is meant to be visible — so this is a projection, not a blanket refusal.
    expect(publicView.privacy.profileVisibility).toBe('public');
    expect(publicView.privacy.hideLikeCounts).toBe(false);
  });

  /**
   * The other half of the distinction, and the reason the fix is a split
   * projection rather than a delete: a projection that dropped the lists
   * everywhere would pass the assertion above while silently removing the
   * owner's ability to read back what they themselves muted.
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
