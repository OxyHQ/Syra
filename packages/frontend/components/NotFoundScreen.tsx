import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { Button } from '@/components/ui/Button';

export default function NotFoundScreen() {
  const { t } = useTranslation();
    const router = useRouter();
    const theme = useTheme();

    return (
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
            <ThemedView style={styles.container}>
                {/* Illustration */}
                <View style={styles.illustrationWrap}>
                    <NoUpdatesIllustration width={200} height={200} />
                </View>

                {/* Title */}
                <ThemedText style={styles.title}>{t('notFound.title')}</ThemedText>

                {/* Message */}
                <ThemedText style={[styles.message, { color: theme.colors.textSecondary }]}>
                    {t('notFound.message')}
                </ThemedText>

                {/* Buttons */}
                <View style={styles.buttonsContainer}>
                    <Button variant="primary" onPress={() => router.back()}>
                        {t('common.goBack')}
                    </Button>

                    <Button variant="secondary" onPress={() => router.push('/')}>
                        {t('common.home')}
                    </Button>
                </View>
            </ThemedView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    illustrationWrap: {
        width: 220,
        height: 220,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 12,
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        lineHeight: 24,
        marginBottom: 32,
        maxWidth: 320,
    },
    buttonsContainer: {
        width: '100%',
        maxWidth: 320,
        gap: 12,
    },
});

