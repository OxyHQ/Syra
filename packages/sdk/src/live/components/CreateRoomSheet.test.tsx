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
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
  }) =>
    React.createElement(
      'FlatList',
      null,
      data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: keyExtractor(item) },
          renderItem({ item, index }),
        ),
      ),
    ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  AccessibilityInfo: { announceForAccessibility: (m: string) => announce(m) },
}));
mock.module('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: (props: { name: string }) => React.createElement('glyph', props),
}));

const announce = mock((_message: string) => {});
const toast = Object.assign(
  mock((_m: string) => {}),
  {
    success: mock((_m: string) => {}),
    error: mock((_m: string) => {}),
  },
);
const createRoom = mock(async (_data: unknown): Promise<unknown> => null);
const startRoom = mock(async (_id: string) => true);
const joinLiveRoom = mock((_id: string) => {});
const theme = {
  colors: {
    text: '#111',
    textSecondary: '#555',
    textTertiary: '#999',
    background: '#fff',
    backgroundSecondary: '#eee',
    card: '#fff',
    border: '#ddd',
    primary: '#06f',
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
      (n) =>
        typeof n.type !== 'string' &&
        n.props.placeholder === "What's your room about?" &&
        !!n.props.onChangeText,
    );
    await act(async () => input.props.onChangeText(value));
  };
  const press = async (label: string) => {
    const button = renderer.root.find(
      (n) =>
        typeof n.props.onPress === 'function' &&
        typeof n.type !== 'string' &&
        textOf(n).includes(label),
    );
    await act(async () => {
      await button.props.onPress();
    });
  };
  const errorBanner = () =>
    renderer.root.findAll(
      (n) => n.props.testID === 'create-room-error' && typeof n.type !== 'string',
    );
  return { renderer, onClose, typeTitle, press, errorBanner };
}

beforeEach(() => {
  for (const m of [announce, toast, toast.error, createRoom, startRoom, joinLiveRoom])
    m.mockClear();
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
    createRoom.mockImplementation(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    });
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
      (n) =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === 'Close' &&
        typeof n.props.onPress === 'function',
    );
    expect(close.props.accessibilityRole).toBe('button');
  });
});

// OxyHQ/Mention#1124: the room modes were focusable boxes with no role and no
// selected state; only their tint said which one was chosen.
describe('CreateRoomSheet choices', () => {
  const modes = (renderer: Renderer) =>
    ['talk', 'stage', 'broadcast'].map((value) =>
      renderer.root.find(
        (n) => n.props.testID === `create-room-type-${value}` && typeof n.type !== 'string',
      ),
    );

  test('the room modes are a labelled exclusive group, each announcing whether it is chosen', async () => {
    const { renderer } = await renderSheet();
    const group = renderer.root.find(
      (n) =>
        n.props.accessibilityRole === 'radiogroup' &&
        n.props.accessibilityLabel === 'Room type' &&
        typeof n.type !== 'string',
    );
    expect(group).toBeDefined();

    const [talk, stage, broadcast] = modes(renderer);
    for (const mode of [talk, stage, broadcast]) {
      expect(mode.props.accessibilityRole).toBe('radio');
    }
    expect(talk.props.accessibilityLabel).toBe('Talk. Open conversation');
    expect([talk, stage, broadcast].map((m) => m.props.accessibilityState.checked)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('choosing a mode moves the checked state to it, and only to it', async () => {
    const { renderer } = await renderSheet();
    await act(async () => modes(renderer)[2].props.onPress());
    expect(modes(renderer).map((m) => m.props.accessibilityState.checked)).toEqual([
      false,
      false,
      true,
    ]);

    await act(async () => modes(renderer)[1].props.onPress());
    expect(modes(renderer).map((m) => m.props.accessibilityState.checked)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test('the other exclusive choices say which option is chosen too', async () => {
    const { renderer } = await renderSheet();
    const radios = renderer.root.findAll(
      (n) => n.props.accessibilityRole === 'radio' && typeof n.type !== 'string',
    );
    // Three modes, the topics, and the three speaker permissions.
    expect(radios.length).toBeGreaterThan(6);
    for (const radio of radios) {
      expect(typeof radio.props.accessibilityLabel).toBe('string');
      expect(typeof radio.props.accessibilityState.checked).toBe('boolean');
    }
    // The default is invited speakers only, and exactly that one says so.
    const speakers = radios.filter((r) =>
      ['Everyone', 'People you follow', 'Only invited speakers'].includes(
        r.props.accessibilityLabel,
      ),
    );
    expect(speakers.map((r) => r.props.accessibilityState.checked)).toEqual([false, false, true]);
  });
});
