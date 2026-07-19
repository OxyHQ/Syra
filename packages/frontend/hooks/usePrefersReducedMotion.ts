import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Whether the user has requested reduced motion.
 *
 * Web reads the `prefers-reduced-motion` media query live (updates if the OS
 * setting changes). Native defaults to `false` here — the artwork-theming
 * cross-fade this gates is a web-only affordance, and native RN motion honours
 * reduced-motion through its own `AccessibilityInfo` paths elsewhere.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return reduced;
}
