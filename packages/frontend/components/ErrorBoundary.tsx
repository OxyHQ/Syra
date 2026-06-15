import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { withTranslation } from 'react-i18next';

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
    return (
        <View className="flex-1 items-center justify-center bg-background px-5">
            <Text className="text-2xl font-bold mb-3 text-center text-foreground">
                {t('error.boundary.title')}
            </Text>
            <Text className="text-base text-center mb-6 leading-[22px] px-4 text-muted-foreground">
                {t('error.boundary.message')}
            </Text>
            <TouchableOpacity
                className="bg-primary px-6 py-3 rounded-xl min-w-[120px] items-center"
                onPress={onRetry}
            >
                <Text className="text-base font-semibold text-primary-foreground">
                    {t('error.boundary.retry')}
                </Text>
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
