import { ownedShowStateKey } from './podcastFormat';

/**
 * The label an owned show carries in the library, and the ORDER it is decided
 * in.
 *
 * `status` and `visibility` are independent axes, so most of the cases below are
 * COMBINATIONS rather than single states — a show that is only ever tested one
 * axis at a time cannot tell a correct precedence from a reversed one, and a
 * reversed one tells a creator their show is reachable when it is not.
 */
describe('ownedShowStateKey', () => {
  it('names a fully public show live', () => {
    // The positive control: without it every assertion below is satisfied by a
    // function that never returns `live`.
    expect(ownedShowStateKey({ status: 'active', visibility: 'public' })).toBe(
      'library.showState.live',
    );
  });

  it('names an unpublished show unpublished', () => {
    expect(ownedShowStateKey({ status: 'unavailable', visibility: 'public' })).toBe(
      'library.showState.unpublished',
    );
  });

  it('names a platform-removed show removed, not merely unpublished', () => {
    // `removed` is the platform's and the creator cannot undo it; `unavailable`
    // is their own unpublish and they can. Collapsing the two would tell a
    // creator to press a Publish button that will refuse them.
    expect(ownedShowStateKey({ status: 'removed', visibility: 'public' })).toBe(
      'library.showState.removed',
    );
  });

  it('names a private show private', () => {
    expect(ownedShowStateKey({ status: 'active', visibility: 'private' })).toBe(
      'library.showState.private',
    );
  });

  it('names an unlisted show unlisted, and does not call it live', () => {
    // The case a "public or not" boolean gets wrong: `unlisted` is reachable by
    // link, so a check for `visibility !== 'private'` reports it as live.
    expect(ownedShowStateKey({ status: 'active', visibility: 'unlisted' })).toBe(
      'library.showState.unlisted',
    );
  });

  it('reports the status axis over the visibility axis', () => {
    // Both axes blocked at once. A creator whose show is unpublished AND private
    // has to undo the publish first, so that is what the label names.
    expect(ownedShowStateKey({ status: 'unavailable', visibility: 'private' })).toBe(
      'library.showState.unpublished',
    );
    expect(ownedShowStateKey({ status: 'removed', visibility: 'private' })).toBe(
      'library.showState.removed',
    );
  });

  it('never reports live for anything but active AND public', () => {
    /**
     * The exhaustive sweep over both server enums, so a state added to either
     * one cannot quietly inherit the `live` label. The two arrays mirror
     * `PODCAST_STATUSES` and `PODCAST_VISIBILITIES` in the backend schema; a
     * value added there and not here is invisible to this test, which is why the
     * cases above name each state individually as well.
     */
    const live: string[] = [];
    for (const status of ['active', 'unavailable', 'removed']) {
      for (const visibility of ['public', 'unlisted', 'private']) {
        if (ownedShowStateKey({ status, visibility }) === 'library.showState.live') {
          live.push(`${status}/${visibility}`);
        }
      }
    }
    expect(live).toEqual(['active/public']);
  });
});
