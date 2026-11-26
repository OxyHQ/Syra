import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { logger } from '@/utils/logger';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

// Fallback UI is a function component so it can read the Bloom theme tokens
// through a hook (class components cannot use hooks).
function ErrorFallbackView({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.mutedText}>
        The studio hit an unexpected error. Try again — your shows and episodes are safe.
      </Text>
      <Pressable style={styles.surface} onPress={onRetry}>
        <Text style={styles.title2}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Error caught by boundary', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <ErrorFallbackView onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

const useStyles = createTokenStyles((t) => ({
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
    paddingHorizontal: 20,
  },
  title: {
    marginBottom: 12,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: 700,
    color: t.foreground,
    lineHeight: 32,
  },
  mutedText: {
    marginBottom: 24,
    paddingHorizontal: 16,
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 22,
    color: t.mutedForeground,
  },
  surface: {
    minWidth: 120,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: t.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  title2: { fontSize: 16, fontWeight: 600, color: t.primaryForeground, lineHeight: 24 },
}));
