import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { logger } from '@/utils/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

// Fallback UI is a function component so it can consume NativeWind theme tokens
// via className (class components cannot use hooks).
function ErrorFallbackView({ onRetry }: { onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center bg-background px-5">
      <Text className="text-2xl font-bold mb-3 text-center text-foreground">
        Something went wrong
      </Text>
      <Text className="text-base text-center mb-6 leading-[22px] px-4 text-muted-foreground">
        The studio hit an unexpected error. Try again — your shows and episodes are safe.
      </Text>
      <Pressable
        className="bg-primary px-6 py-3 rounded-xl min-w-[120px] items-center"
        onPress={onRetry}
      >
        <Text className="text-base font-semibold text-primary-foreground">Try again</Text>
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
