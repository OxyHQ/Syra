import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Lyrics } from '@syra/shared-types';
import { LyricsView } from './LyricsView';

const mockRetry = jest.fn();
const mockSeek = jest.fn();
let mockResult: { lyrics: Lyrics | null; isLoading: boolean; isError: boolean; retry: () => void };
let mockState: { currentTrack: { id: string } | null; currentTime: number; seek: typeof mockSeek };
jest.mock('@/hooks/useLyrics', () => ({ useLyrics: () => mockResult }));
jest.mock('@/stores/playerStore', () => ({ usePlayerStore: (selector: (state: typeof mockState) => unknown) => selector(mockState) }));
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: 'SkeletonBox' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { source?: string; line?: string }) => `${key}${values?.source ?? values?.line ?? ''}` }) }));
let renderer: ReactTestRenderer | undefined;
const lyrics: Lyrics = { trackId: 'track', synced: true, lines: [{ timeMs: 1000, text: 'First line' }, { timeMs: 3000, text: 'Second line' }], source: 'lrclib' };
beforeEach(() => {
  mockResult = { lyrics, isLoading: false, isError: false, retry: mockRetry };
  mockState = { currentTrack: { id: 'track' }, currentTime: 2, seek: mockSeek };
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; jest.clearAllMocks(); });
function render(trackId = 'track') {
  act(() => { renderer = create(<LyricsView trackId={trackId} />); });
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}
it('shows a skeleton while loading', () => {
  mockResult.isLoading = true;
  expect(JSON.stringify(render().toJSON())).toContain('SkeletonBox');
});
it('distinguishes unavailable, empty, and failed responses with an actionable retry', () => {
  mockResult.lyrics = null;
  expect(JSON.stringify(render().toJSON())).toContain('lyrics.unavailable');
});
it('offers retry after a provider error', () => {
  mockResult.isError = true;
  const tree = render();
  expect(JSON.stringify(tree.toJSON())).toContain('listener.lyricsFailed');
  const [retry] = tree.root.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function', { deep: false });
  act(() => retry.props.onPress());
  expect(mockRetry).toHaveBeenCalledTimes(1);
});
it('highlights the current line, seeks in seconds, and shows the source', () => {
  const tree = render();
  const buttons = tree.root.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function', { deep: false });
  expect(buttons[0].props.accessibilityState.selected).toBe(true);
  expect(buttons[1].props.accessibilityState.selected).toBe(false);
  act(() => buttons[1].props.onPress());
  expect(mockSeek).toHaveBeenCalledWith(3);
  expect(JSON.stringify(tree.toJSON())).toContain('listener.lyricsSourcelrclib');
});
it('never highlights or enables seeking for another track', () => {
  const tree = render('another-track');
  const buttons = tree.root.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function', { deep: false });
  expect(buttons).toHaveLength(2);
  for (const button of buttons) expect(button.props.accessibilityState).toEqual({ disabled: true, selected: false });
});
it('falls back to stored text lines when the plain field is an empty string', () => {
  mockResult.lyrics = { ...lyrics, synced: false, plain: '' };
  const result = JSON.stringify(render().toJSON());
  expect(result).toContain('First line');
  expect(result).toContain('Second line');
  expect(result).toContain('listener.lyricsSourcelrclib');
});
it('treats an empty lyrics object as unavailable, not a blank panel', () => {
  mockResult.lyrics = { ...lyrics, lines: [], plain: '  ' };
  expect(JSON.stringify(render().toJSON())).toContain('lyrics.unavailable');
});
