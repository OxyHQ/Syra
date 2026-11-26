import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { withTranslation } from 'react-i18next';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  t: (key: string) => string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Fallback UI rendered as a function component so it can consume NativeWind theme
// tokens via className (class components cannot use hooks directly).
function ErrorFallbackView({ t, onRetry }: { t: (key: string) => string; onRetry: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>{t('error.boundary.title')}</Text>
      <Text style={styles.mutedText}>{t('error.boundary.message')}</Text>
      <TouchableOpacity style={styles.surface} onPress={onRetry}>
        <Text style={styles.title2}>{t('error.boundary.retry')}</Text>
      </TouchableOpacity>
    </View>
  );
}

class ErrorBoundaryBase extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Import logger at module level to avoid circular dependencies
    const { logger } = require('../utils/logger');
    logger.error('Error caught by boundary', { error, errorInfo });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <ErrorFallbackView t={this.props.t} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}

// Wrap the component with translation HOC. The HOC injects `t`, so the public
// props are `Props` without it. An explicit annotation is required because the
// HOC's inferred return type references react-i18next's internal `$Subtract`
// helper, which TypeScript cannot name portably at the export boundary (TS2883).
type ErrorBoundaryProps = Omit<Props, 't'>;
const ErrorBoundary: React.ComponentType<ErrorBoundaryProps> = withTranslation()(ErrorBoundaryBase);

export default ErrorBoundary;

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
