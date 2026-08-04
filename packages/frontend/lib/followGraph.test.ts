/**
 * The three claims this module makes that nothing else can catch.
 *
 * Every one of them fails silently in production: a URI that varies by
 * environment gives a developer their own parallel follow of an artist, a
 * registration that runs per screen is a request storm nobody notices, and a
 * `reverse` value that drifts to `public` publishes who listens to whom with no
 * error anywhere. Each assertion below is written so that reverting the
 * behaviour it guards fails it — the URI test pins the production origin rather
 * than "some origin", and the registry test counts calls rather than asserting
 * one happened.
 */

const mockClaimFollowNamespace = jest.fn();
const mockRegisterFollowKind = jest.fn();
const mockEnsureFollowTarget = jest.fn();

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    claimFollowNamespace: (...args: unknown[]) => mockClaimFollowNamespace(...args),
    registerFollowKind: (...args: unknown[]) => mockRegisterFollowKind(...args),
    ensureFollowTarget: (...args: unknown[]) => mockEnsureFollowTarget(...args),
  },
}));

/**
 * The memo that makes registration once-per-run is module state, so every test
 * takes a fresh copy of the module rather than inheriting the previous one's.
 */
function loadModule(): typeof import('./followGraph') {
  jest.resetModules();
  // `requireActual` rather than a dynamic `import()`: this Jest runtime has no
  // ESM module loader, and it only un-mocks the module named here — the mocked
  // `@/lib/oxyServices` it depends on still comes from the registry.
  return jest.requireActual('./followGraph');
}

beforeEach(() => {
  mockClaimFollowNamespace.mockReset().mockResolvedValue({ namespace: 'syra', created: true });
  mockRegisterFollowKind.mockReset().mockResolvedValue({ kind: 'syra.artist', created: true });
  mockEnsureFollowTarget
    .mockReset()
    .mockResolvedValue({ id: 'target-1', uri: '', kind: 'syra.artist', created: true });
});

describe('artistFollowUri', () => {
  it('names an artist by their production profile URL', async () => {
    const { artistFollowUri } = loadModule();
    expect(artistFollowUri('artist-1')).toBe('https://syra.fm/p/artist-1');
  });

  it('does not vary with the API base URL a build was made against', async () => {
    const { artistFollowUri } = loadModule();
    const before = artistFollowUri('artist-1');

    process.env.EXPO_PUBLIC_API_URL = 'http://localhost:4120/api';
    const { artistFollowUri: reloaded } = loadModule();

    expect(reloaded('artist-1')).toBe(before);
    delete process.env.EXPO_PUBLIC_API_URL;
  });
});

describe('ensureSyraFollowRegistry', () => {
  it('registers the namespace and the kind exactly once across many callers', async () => {
    const { ensureSyraFollowRegistry } = loadModule();

    await Promise.all([
      ensureSyraFollowRegistry(),
      ensureSyraFollowRegistry(),
      ensureSyraFollowRegistry(),
    ]);
    await ensureSyraFollowRegistry();

    expect(mockClaimFollowNamespace).toHaveBeenCalledTimes(1);
    expect(mockClaimFollowNamespace).toHaveBeenCalledWith('syra');
    expect(mockRegisterFollowKind).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure instead of holding it for the rest of the session', async () => {
    const { ensureSyraFollowRegistry } = loadModule();
    mockClaimFollowNamespace.mockRejectedValueOnce(new Error('offline'));

    await expect(ensureSyraFollowRegistry()).rejects.toThrow('offline');
    await expect(ensureSyraFollowRegistry()).resolves.toBeUndefined();

    expect(mockClaimFollowNamespace).toHaveBeenCalledTimes(2);
    expect(mockRegisterFollowKind).toHaveBeenCalledTimes(1);
  });

  it("answers an artist's followers with a count and never a list", async () => {
    const { ensureSyraFollowRegistry } = loadModule();
    await ensureSyraFollowRegistry();

    // Pinned deliberately: `public` here would disclose who listens to whom,
    // and it is a one-line edit away with nothing else in the tree to stop it.
    expect(mockRegisterFollowKind).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'syra.artist',
        capabilities: expect.objectContaining({ verb: 'follow', reverse: 'aggregate' }),
      }),
    );
  });
});

describe('ensureArtistFollowTarget', () => {
  it('resolves the target by canonical URI and returns its id', async () => {
    const { ensureArtistFollowTarget } = loadModule();

    await expect(
      ensureArtistFollowTarget({ artistId: 'artist-1', name: 'Artist One' }),
    ).resolves.toBe('target-1');

    expect(mockEnsureFollowTarget).toHaveBeenCalledWith({
      uri: 'https://syra.fm/p/artist-1',
      kind: 'syra.artist',
      metadata: { name: 'Artist One' },
      providerReference: 'artist-1',
    });
  });

  it('registers before it resolves, so the kind exists when the target names it', async () => {
    const { ensureArtistFollowTarget } = loadModule();
    await ensureArtistFollowTarget({ artistId: 'artist-1', name: 'Artist One' });

    expect(mockRegisterFollowKind.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsureFollowTarget.mock.invocationCallOrder[0],
    );
  });

  it('carries an Oxy avatar as the icon, and omits it entirely when there is none', async () => {
    const { ensureArtistFollowTarget } = loadModule();

    await ensureArtistFollowTarget({
      artistId: 'artist-1',
      name: 'Artist One',
      avatarFileId: 'file-1',
    });
    expect(mockEnsureFollowTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: { name: 'Artist One', icon: 'file-1' } }),
    );

    // An empty string is the shape a missing avatar actually arrives in from the
    // catalogue, and it is the one that tells a truthiness check from a
    // presence check — `icon: ''` would ship an unresolvable id to every other
    // application's follow list.
    await ensureArtistFollowTarget({ artistId: 'artist-2', name: 'Artist Two', avatarFileId: '' });
    expect(mockEnsureFollowTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: { name: 'Artist Two' } }),
    );
  });
});
