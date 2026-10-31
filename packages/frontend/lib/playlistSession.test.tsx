import { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput, View } from 'react-native';

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { http: { getSessionEpoch: () => 1, getAccessToken: () => null }, session: {} },
}));
import { usePlaylistOwnerRetry } from './playlistSession';

function Form({ owner }: { owner: object }) {
  const [name, setName] = useState('');
  const { needsRetry, clearRetry } = usePlaylistOwnerRetry(owner);
  return (
    <View>
      <TextInput testID="draft" value={name} onChangeText={setName} />
      {needsRetry ? (
        <Text testID="notice" onPress={clearRetry}>
          Check before retrying
        </Text>
      ) : null}
    </View>
  );
}

it('keeps the draft and shows a retry notice if the committed owner object is replaced', async () => {
  const first = {};
  let tree: TestRenderer.ReactTestRenderer | undefined;
  const rendered = () => {
    if (!tree) throw new Error('Form was not mounted');
    return tree;
  };
  await act(async () => {
    tree = TestRenderer.create(<Form owner={first} />);
  });
  await act(async () => {
    rendered().root.findByProps({ testID: 'draft' }).props.onChangeText('Private draft');
  });
  await act(async () => {
    rendered().update(<Form owner={{}} />);
  });
  expect(rendered().root.findByProps({ testID: 'draft' }).props.value).toBe('Private draft');
  expect(rendered().root.findByProps({ testID: 'notice' }).props.children).toBe(
    'Check before retrying',
  );
  await act(async () => {
    rendered().root.findByProps({ testID: 'notice' }).props.onPress();
  });
  expect(rendered().root.findAllByProps({ testID: 'notice' })).toHaveLength(0);
  expect(rendered().root.findByProps({ testID: 'draft' }).props.value).toBe('Private draft');
  await act(async () => rendered().unmount());
});
