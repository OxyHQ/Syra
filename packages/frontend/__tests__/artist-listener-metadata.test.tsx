import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ArtistStats, Track } from '@syra/shared-types';
import { MonthlyListeners } from '@/components/artist/MonthlyListeners';
import { TrackCredits } from '@/components/TrackCredits';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockNavigate }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'es' },
    t: (key: string, values?: { count?: number; formatted?: string }) =>
      key === 'listener.monthly' ? `${values?.formatted} oyentes mensuales` : key,
  }),
}));

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  jest.clearAllMocks();
});

function render(element: React.ReactElement) {
  act(() => { renderer = create(element); });
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}

const stats: ArtistStats = { followers: 10, albums: 1, tracks: 3, totalPlays: 123 };
const track: Track = {
  id: 'recording', title: 'A recording', artistId: 'artist', artistName: 'Artist',
  duration: 180, isExplicit: false, isAvailable: true, source: 'upload', status: 'ready',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

it('does not turn a missing monthly aggregate into zero or a follower count', () => {
  expect(render(<MonthlyListeners stats={{ ...stats, monthlyListeners: 0 }} />).toJSON()).toBeNull();
});

it('renders a computed zero and formats a positive count for the listener language', () => {
  const tree = render(<MonthlyListeners stats={{ ...stats, monthlyListeners: 0, monthlyListenersComputedAt: '2026-09-15T00:00:00Z' }} />);
  expect(JSON.stringify(tree.toJSON())).toContain('0 oyentes mensuales');
  act(() => tree.update(<MonthlyListeners stats={{ ...stats, monthlyListeners: 123456, monthlyListenersComputedAt: '2026-09-15T00:00:00Z' }} />));
  expect(JSON.stringify(tree.toJSON())).toContain('123.456 oyentes mensuales');
});

it('shows an explicit unavailable state instead of inventing credits', () => {
  expect(JSON.stringify(render(<TrackCredits track={track} />).toJSON())).toContain('listener.noCredits');
});

it('links resolved credits only and preserves unfamiliar roles as factual text', () => {
  const tree = render(<TrackCredits track={{ ...track, credits: [
    { name: 'Known artist', nameKey: 'known-artist', role: 'performer', catalogEntityId: 'resolved-artist' },
    { name: 'Unresolved contributor', nameKey: 'unresolved-contributor', role: 'field_recording' },
  ] }} />);
  const links = tree.root.findAll((node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function', { deep: false });
  expect(links).toHaveLength(1);
  act(() => links[0].props.onPress());
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/p/[id]', params: { id: 'resolved-artist' } });
  expect(JSON.stringify(tree.toJSON())).toContain('field_recording');
  expect(JSON.stringify(tree.toJSON())).toContain('Unresolved contributor');
});
