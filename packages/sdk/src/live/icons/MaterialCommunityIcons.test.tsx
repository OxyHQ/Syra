import { describe, expect, mock, test } from 'bun:test';
import React from 'react';

// The real font component needs a React Native runtime; the wrapper's job is
// only the props it hands it, so a stand-in that records them is enough.
function BaseGlyph(_props: Record<string, unknown>) {
  return null;
}
mock.module('@expo/vector-icons/MaterialCommunityIcons', () => ({ default: BaseGlyph }));

const { MaterialCommunityIcons } = await import('./MaterialCommunityIcons');

function propsOf(element: unknown): Record<string, unknown> {
  const rendered = (MaterialCommunityIcons as (p: never) => React.ReactElement)(element as never);
  expect(rendered.type).toBe(BaseGlyph);
  return rendered.props as Record<string, unknown>;
}

describe('MaterialCommunityIcons', () => {
  test('hides the glyph from assistive technology', () => {
    const props = propsOf({ name: 'microphone', size: 22, color: '#000' });
    expect(props['aria-hidden']).toBe(true);
    expect(props.name).toBe('microphone');
    expect(props.size).toBe(22);
  });

  test('a call site cannot switch the glyph back on', () => {
    const props = propsOf({ name: 'play', 'aria-hidden': false });
    expect(props['aria-hidden']).toBe(true);
  });
});
