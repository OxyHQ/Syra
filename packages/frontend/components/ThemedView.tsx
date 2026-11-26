import { View, type ViewProps } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export type ThemedViewProps = ViewProps;

/** A `View` on the theme's background; `style` lays it out and can repaint it. */
export function ThemedView({ style, ...otherProps }: ThemedViewProps) {
  const themed = useThemedStyles();
  return <View style={[themed.background, style]} {...otherProps} />;
}

const useThemedStyles = createTokenStyles((t) => ({
  background: { backgroundColor: t.background },
}));
