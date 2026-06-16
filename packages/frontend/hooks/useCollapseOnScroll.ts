import {
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * Scroll-direction thresholds for the collapse/expand interaction. The target
 * collapses only after scrolling DOWN past a small delta while below the top
 * region, and re-expands on any upward scroll or when near the top.
 */
const COLLAPSE_SCROLL_THRESHOLD = 24;
const COLLAPSE_DELTA = 6;
const COLLAPSE_TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };

interface UseCollapseOnScroll {
  /**
   * 1 = expanded, 0 = collapsed. Updated entirely on the UI thread, so wiring
   * it to a Reanimated-driven prop (e.g. {@link Fab}'s `expanded`) triggers no
   * React re-renders.
   */
  expanded: SharedValue<number>;
  /** Attach to an `Animated.ScrollView`'s `onScroll`. */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
}

/**
 * Collapses a UI element (e.g. an extended FAB) when the user scrolls down and
 * re-expands it on upward scroll or near the top, with a small hysteresis delta
 * so micro-scrolls don't flicker the state.
 */
export function useCollapseOnScroll(): UseCollapseOnScroll {
  const expanded = useSharedValue(1);
  const lastScrollY = useSharedValue(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      const delta = y - lastScrollY.value;
      if (y <= COLLAPSE_SCROLL_THRESHOLD || delta < -COLLAPSE_DELTA) {
        // Near the top, or scrolling up: expand back.
        expanded.value = withTiming(1, COLLAPSE_TIMING);
      } else if (delta > COLLAPSE_DELTA) {
        // Scrolling down past the threshold: collapse.
        expanded.value = withTiming(0, COLLAPSE_TIMING);
      }
      lastScrollY.value = y;
    },
  });

  return { expanded, scrollHandler };
}
