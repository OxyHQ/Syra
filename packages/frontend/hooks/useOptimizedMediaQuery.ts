import { useMemo } from 'react';
import { useMediaQuery } from 'react-responsive';

/**
 * Optimized media query hook that prevents unnecessary rerenders
 * by creating stable query objects
 */
export function useOptimizedMediaQuery(query: {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}) {
  // Memoize the query object to prevent unnecessary rerenders. react-responsive
  // skips undefined keys, so rebuilding it from the four fields is equivalent.
  const { minWidth, maxWidth, minHeight, maxHeight } = query;
  const stableQuery = useMemo(
    () => ({ minWidth, maxWidth, minHeight, maxHeight }),
    [minWidth, maxWidth, minHeight, maxHeight],
  );

  return useMediaQuery(stableQuery);
}

/**
 * Predefined optimized media query hooks for common breakpoints
 */
export function useIsMobile() {
  return useOptimizedMediaQuery({ maxWidth: 767 });
}

export function useIsTablet() {
  return useOptimizedMediaQuery({ minWidth: 768, maxWidth: 1023 });
}

export function useIsDesktop() {
  return useOptimizedMediaQuery({ minWidth: 1024 });
}

export function useIsLargeDesktop() {
  return useOptimizedMediaQuery({ minWidth: 1440 });
}

export function useIsRightBarVisible() {
  return useOptimizedMediaQuery({ minWidth: 990 });
}

export function useIsScreenNotMobile() {
  return useOptimizedMediaQuery({ minWidth: 500 });
}
