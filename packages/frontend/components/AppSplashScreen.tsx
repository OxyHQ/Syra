import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { View, Animated, Platform, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { LogoIcon } from '@/assets/logo';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useTheme } from '@oxyhq/bloom/theme';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 500;
// Hard ceiling on how long the cosmetic fade may withhold readiness. On web the
// fade is driven by requestAnimationFrame, which a backgrounded tab pauses
// indefinitely — without this the animation callback would never run and the app
// would sit on the splash forever.
const FADE_COMPLETE_TIMEOUT = FADE_DURATION + 250;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const theme = useTheme();
    // Lazy state initializer yields a stable Animated.Value that is safe to read
    // during render (unlike `useRef(...).current`, which the React Compiler forbids).
    const [fadeAnim] = useState(() => new Animated.Value(1));
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);
    const completedRef = useRef(false);

    // The fade is purely cosmetic and must never gate app readiness, so completion
    // is reported whether the animation finished, was interrupted, or stalled.
    // Latched so the animation callback and the timeout below can't double-report.
    const handleFadeComplete = useCallback(() => {
        if (completedRef.current) {
            return;
        }
        completedRef.current = true;
        onFadeComplete?.();
    }, [onFadeComplete]);

    useEffect(() => {
        if (!startFade) {
            return;
        }

        // Cancel any existing animation
        animationRef.current?.stop();

        // Start fade out animation
        animationRef.current = Animated.timing(fadeAnim, {
            toValue: 0,
            duration: FADE_DURATION,
            useNativeDriver: Platform.OS !== 'web',
        });

        animationRef.current.start(handleFadeComplete);

        const fallbackTimer = setTimeout(handleFadeComplete, FADE_COMPLETE_TIMEOUT);

        return () => {
            clearTimeout(fallbackTimer);
            animationRef.current?.stop();
        };
    }, [startFade, fadeAnim, handleFadeComplete]);

    // Memoized styles
    const containerStyle = useMemo(
        () => [styles.container, { opacity: fadeAnim }],
        [fadeAnim]
    );

    // Gradient colors: background to primary for visual depth
    const gradientColors = useMemo(
        () => [
            theme?.colors?.background || '#ffffff',
            theme?.colors?.primary || '#000000',
        ] as const,
        [theme?.colors?.background, theme?.colors?.primary]
    );

    return (
        <Animated.View style={containerStyle}>
            <LinearGradient
                colors={gradientColors}
                style={styles.gradient}
            >
                <View style={styles.logoContainer}>
                    <LogoIcon size={LOGO_SIZE} color="white" />
                    <View style={styles.spinnerContainer}>
                        <LoadingSpinner iconSize={SPINNER_SIZE} color="white" showText={false} />
                    </View>
                </View>
            </LinearGradient>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    gradient: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    spinnerContainer: {
        marginTop: 32,
    },
});

export default React.memo(AppSplashScreen);
