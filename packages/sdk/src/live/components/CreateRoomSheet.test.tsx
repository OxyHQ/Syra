import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';

// React Native's own entry is Flow source only Metro/babel can load, so the
// primitives the sheet uses are stood in by host elements of the same name that
// keep every prop: the tree, props and handlers asserted on are the sheet's own.
function host(name: string) {
  const Component = (props: Record<string, unknown>) => React.createElement(name, props);
  Component.displayName = name;
  return Component;
}
mock.module('react-native', () => ({
  View: host('View'),
  Text: host('Text'),
  TextInput: host('TextInput'),
  TouchableOpacity: host('TouchableOpacity'),
  ScrollView: host('ScrollView'),
  FlatList: ({ data, renderItem, keyExtractor }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
  }) => React.createElement('FlatList', null, data.map((item, index) =>
    React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))),
  StyleSheet: { create: <T,>(styles: T) => styles },
  AccessibilityInfo: { announceForAccessibility: (m: string) => announce(m) },
}));
mock.module('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: (props: { name: string }) => React.createElement('glyph', props),
}));

const announce = mock((_message: string) => {});
const toast = Object.assign(mock((_m: string) => {}), {
  success: mock((_m: string) => {}),
  error: mock((_m: string) => {}),
});
const createRoom = mock(async (_data: unknown): Promise<unknown> => null);
const startRoom = mock(async (_id: string) => true);
const joinLiveRoom = mock((_id: string) => {});
const theme = {
  colors: {
    text: '#111', textSecondary: '#555', textTertiary: '#999', background: '#fff',
    backgroundSecondary: '#eee', card: '#fff', border: '#ddd', primary: '#06f',
  },
};

mock.module('../context/LiveConfigContext', () => ({
  useLiveConfig: () => ({ useTheme: () => theme, roomsService: { createRoom, startRoom }, toast }),
}));
mock.module('../context/LiveRoomContext', () => ({ useLiveRoom: () => ({ joinLiveRoom }) }));

const { act, create } = await import('react-test-renderer');
const { CreateRoomSheet, CREATE_ROOM_ERRORS } = await import('./CreateRoomSheet');

// react-test-renderer is deprecated in React 19 and says so on every create.
const quiet = console.error;
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes('react-test-renderer is deprecated')) return;
  quiet(...args);
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Renderer = ReturnType<typeof create>;
type Node = Renderer['root'];

function textOf(node: Node | string): string {
  if (typeof node === 'string') return node;
  return (node.children as (Node | string)[]).map(textOf).join('');
}

async function renderSheet(onClose = mock(() => {})) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = create(<CreateRoomSheet onClose={onClose} />);
  });
  const typeTitle = async (value: string) => {
    const input = renderer.root.find(
      (n) => typeof n.type !== 'string' && n.props.placeholder === "What's your room about?" && !!n.props.onChangeText,
    );
    await act(async () => input.props.onChangeText(value));
  };
  const press = async (label: string) => {
    const button = renderer.root.find(
      (n) => typeof n.props.onPress === 'function' && typeof n.type !== 'string' && textOf(n).includes(label),
    );
    await act(async () => { await button.props.onPress(); });
  };
  const errorBanner = () => renderer.root.findAll((n) => n.props.testID === 'create-room-error' && typeof n.type !== 'string');
  return { renderer, onClose, typeTitle, press, errorBanner };
}

beforeEach(() => {
  for (const m of [announce, toast, toast.error, createRoom, startRoom, joinLiveRoom]) m.mockClear();
  createRoom.mockImplementation(async () => null);
});

describe('CreateRoomSheet failure feedback', () => {
  test('a failed create shows the error inside the sheet and keeps it open', async () => {
    const { onClose, typeTitle, press, errorBanner } = await renderSheet();
    await typeTitle('Friday jam');
    await press('Start Now');

    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    const [banner] = errorBanner();
    expect(banner).toBeDefined();
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(textOf(banner)).toContain(CREATE_ROOM_ERRORS.createFailed);
    expect(announce).toHaveBeenCalledWith(CREATE_ROOM_ERRORS.createFailed);
    // Not to the toast: it renders in the window underneath the sheet.
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('a thrown create is reported the same way', async () => {
    createRoom.mockImplementation(async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); });
    const quietError = console.error;
    console.error = () => {};
    try {
      const { onClose, typeTitle, press, errorBanner } = await renderSheet();
      await typeTitle('Friday jam');
      await press('Start Now');
      expect(onClose).not.toHaveBeenCalled();
      expect(errorBanner()).toHaveLength(1);
    } finally {
      console.error = quietError;
    }
  });

  test('retrying clears the error, and a success closes the sheet', async () => {
    const { onClose, typeTitle, press, errorBanner } = await renderSheet();
    await typeTitle('Friday jam');
    await press('Start Now');
    expect(errorBanner()).toHaveLength(1);

    createRoom.mockImplementation(async () => ({ id: 'room-1' }));
    await press('Start Now');

    expect(errorBanner()).toHaveLength(0);
    expect(startRoom).toHaveBeenCalledWith('room-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(joinLiveRoom).toHaveBeenCalledWith('room-1');
  });

  test('the icon-only close button carries its own name', async () => {
    const { renderer } = await renderSheet();
    const close = renderer.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function',
    );
    expect(close.props.accessibilityRole).toBe('button');
  });
});
