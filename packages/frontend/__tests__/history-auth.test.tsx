import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import HistoryScreen from '@/app/library/history';

const mockRetry = jest.fn();
const mockRefetch = jest.fn();
let mockCanUsePrivateApi = false;

jest.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/services', () => ({ useOxy: () => ({ user: { id: 'listener' } }) }));
jest.mock('@/hooks/useAuthGate', () => ({
  useAuthGate: () => ({
    canUsePrivateApi: mockCanUsePrivateApi,
    isResolving: false,
    isTimedOut: !mockCanUsePrivateApi,
    status: mockCanUsePrivateApi ? 'authenticated' : 'timed-out',
    retry: mockRetry,
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: true, isPending: false, refetch: mockRefetch }),
}));
jest.mock('@/services/libraryService', () => ({ libraryService: { getRecentlyPlayed: jest.fn() } }));
jest.mock('@/components/TrackRow', () => ({ TrackRow: () => null }));
jest.mock('@/stores/playerStore', () => ({
  usePlayerStore: (selector: (state: { currentTrack: null; isPlaying: boolean; playTrackList: () => void }) => unknown) =>
    selector({ currentTrack: null, isPlaying: false, playTrackList: () => undefined }),
}));

describe('history retries respect the private API gate', () => {
  let screen: ReactTestRenderer | undefined;
  afterEach(() => {
    act(() => screen?.unmount());
    screen = undefined;
    jest.clearAllMocks();
  });

  it('retries session resolution without calling the private endpoint while unresolved', () => {
    mockCanUsePrivateApi = false;
    act(() => { screen = TestRenderer.create(<HistoryScreen />); });
    if (!screen) throw new Error('History screen did not render');
    const retryButton = screen.root.findAllByProps({ accessibilityRole: 'button' })[0];
    if (!retryButton) throw new Error('Retry button did not render');
    act(() => retryButton.props.onPress());
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('retries the history request once the session is authorized', () => {
    mockCanUsePrivateApi = true;
    act(() => { screen = TestRenderer.create(<HistoryScreen />); });
    if (!screen) throw new Error('History screen did not render');
    const retryButton = screen.root.findAllByProps({ accessibilityRole: 'button' })[0];
    if (!retryButton) throw new Error('Retry button did not render');
    act(() => retryButton.props.onPress());
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockRetry).not.toHaveBeenCalled();
  });
});
