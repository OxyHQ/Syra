import React, { memo, useState, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { flattenStyleArray } from '@/styles/shared';
import { Ionicons } from '@expo/vector-icons';

export interface EmptyStateProps {
    title?: string;
    subtitle?: string;
    icon?: {
        name: keyof typeof Ionicons.glyphMap;
        size?: number;
        color?: string;
        backgroundColor?: string;
    };
    error?: {
        title: string;
        message: string;
        onRetry?: () => Promise<void>;
    };
    action?: {
        label: string;
        onPress: () => void;
        icon?: keyof typeof Ionicons.glyphMap;
    };
    customIcon?: ReactNode;
    style?: ViewStyle;
    containerStyle?: ViewStyle;
    /**
     * Container colour, as a Bloom class. Callers used to thread this through
     * `className="bg-surface"` —
     * seventeen of them — which freezes the value at render and cannot follow a
     * preset change. A class can.
     */
    className?: string;
    titleStyle?: TextStyle;
    subtitleStyle?: TextStyle;
    accessible?: boolean;
    accessibilityLabel?: string;
}

/**
 * Reusable empty state component
 * Handles simple empty states, error states with retry, and states with action buttons
 */
export const EmptyState = memo<EmptyStateProps>(
    ({
        title,
        subtitle,
        icon,
        error,
        action,
        customIcon,
        style,
        containerStyle,
        className,
        titleStyle,
        subtitleStyle,
        accessible = true,
        accessibilityLabel,
    }) => {
        const { t } = useTranslation();
        const theme = useTheme();
        const [isRetrying, setIsRetrying] = useState(false);

        const handleRetry = async () => {
            if (!error?.onRetry || isRetrying) return;
            setIsRetrying(true);
            try {
                await error.onRetry();
            } finally {
                setIsRetrying(false);
            }
        };

        // Error state with retry
        if (error) {
            return (
                <View className={className ?? 'bg-background'}
                    style={flattenStyleArray([
                        styles.errorContainer,
                        containerStyle,
                    ])}
                >
                    <View style={styles.errorContent}>
                        {icon && (
                            <View
                                // `bg-error/10` rather than `theme.colors.error + '15'`: a
                                // hex-alpha suffix on a Bloom token yields a malformed colour
                                // react-native-web reads as fully OPAQUE. A caller-supplied
                                // `icon.backgroundColor` still wins — inline beats class.
                                className={icon.backgroundColor ? undefined : 'bg-error/10'}
                                style={[
                                    styles.iconWrapper,
                                    icon.backgroundColor ? { backgroundColor: icon.backgroundColor } : null,
                                ]}
                            >
                                <Ionicons
                                    name={icon.name}
                                    size={icon.size || 36}
                                    color={icon.color || theme.colors.error}
                                />
                            </View>
                        )}

                        <Text className="text-foreground"
                            style={flattenStyleArray([
                                styles.errorTitle,
                                titleStyle,
                            ])}
                        >
                            {error.title}
                        </Text>

                        <Text className="text-muted-foreground"
                            style={flattenStyleArray([
                                styles.errorMessage,
                                subtitleStyle,
                            ])}
                        >
                            {error.message}
                        </Text>

                        {error.onRetry && (
                            <TouchableOpacity
                                style={[
                                    styles.retryButton,
                                    {
                                        backgroundColor: theme.colors.primary,
                                        opacity: isRetrying ? 0.6 : 1,
                                    },
                                ]}
                                onPress={handleRetry}
                                disabled={isRetrying}
                                activeOpacity={0.8}
                            >
                                {isRetrying ? (
                                    <ActivityIndicator
                                        size="small"
                                        color={theme.colors.card}
                                    />
                                ) : (
                                    <>
                                        <Ionicons
                                            name="refresh"
                                            size={18}
                                            color={theme.colors.card}
                                            style={styles.retryIcon}
                                        />
                                        <Text className="text-card"
                                            style={[
                                                styles.retryButtonText,
                                            ]}
                                        >
                                            {t('common.tryAgain')}
                                        </Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }

        // Regular empty state
        if (!title && !subtitle && !customIcon && !icon) {
            return null;
        }

        return (
            <View className={className ?? 'bg-background'}
                style={flattenStyleArray([
                    styles.emptyState,
                    containerStyle,
                ])}
                accessible={accessible}
                accessibilityRole="text"
                accessibilityLabel={accessibilityLabel || `${title || ''}. ${subtitle || ''}`}
            >
                {customIcon && <View style={styles.iconContainer}>{customIcon}</View>}
                
                {icon && !customIcon && (
                    <View
                        style={[
                            styles.iconWrapper,
                            icon.backgroundColor && {
                                backgroundColor: icon.backgroundColor,
                            },
                        ]}
                    >
                        <Ionicons
                            name={icon.name}
                            size={icon.size || 48}
                            color={icon.color || theme.colors.textSecondary}
                        />
                    </View>
                )}

                {title && (
                    <Text className="text-foreground"
                        style={flattenStyleArray([
                            styles.emptyStateText,
                            titleStyle,
                        ])}
                    >
                        {title}
                    </Text>
                )}

                {subtitle && (
                    <Text className="text-muted-foreground"
                        style={flattenStyleArray([
                            styles.emptyStateSubtext,
                            subtitleStyle,
                        ])}
                    >
                        {subtitle}
                    </Text>
                )}

                {action && (
                    <TouchableOpacity className="bg-primary"
                        style={[
                            styles.actionButton,
                        ]}
                        onPress={action.onPress}
                        activeOpacity={0.8}
                    >
                        {action.icon && (
                            <Ionicons
                                name={action.icon}
                                size={18}
                                color={theme.colors.card}
                                style={styles.actionIcon}
                            />
                        )}
                        <Text className="text-card"
                            style={[
                                styles.actionButtonText,
                            ]}
                        >
                            {action.label}
                        </Text>
                    </TouchableOpacity>
                )}
            </View>
        );
    }
);

EmptyState.displayName = 'EmptyState';

const styles = StyleSheet.create({
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 24,
    },
    errorContent: {
        alignItems: 'center',
        maxWidth: 320,
        width: '100%',
    },
    iconWrapper: {
        width: 72,
        height: 72,
        borderRadius: 36,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 12,
    },
    iconContainer: {
        marginBottom: 12,
    },
    errorTitle: {
        fontSize: 18,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 6,
        letterSpacing: -0.3,
    },
    errorMessage: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 16,
    },
    retryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        minWidth: 100,
        gap: 6,
    },
    retryIcon: {
        marginRight: 0,
    },
    retryButtonText: {
        fontSize: 15,
        fontWeight: '600',
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 24,
    },
    emptyStateText: {
        fontSize: 18,
        fontWeight: '700',
        marginTop: 12,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 14,
        marginTop: 6,
        textAlign: 'center',
        lineHeight: 20,
        maxWidth: 280,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        marginTop: 18,
        gap: 6,
    },
    actionIcon: {
        marginRight: 0,
    },
    actionButtonText: {
        fontSize: 15,
        fontWeight: '600',
    },
});

