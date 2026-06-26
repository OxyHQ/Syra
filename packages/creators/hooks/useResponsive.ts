import { useWindowDimensions } from 'react-native';

/** Width at/above which the studio shows the persistent left sidebar. */
const SIDEBAR_BREAKPOINT = 768;

export interface Responsive {
  width: number;
  /** True on tablet/desktop widths where the sidebar is shown inline. */
  isWide: boolean;
}

export function useResponsive(): Responsive {
  const { width } = useWindowDimensions();
  return { width, isWide: width >= SIDEBAR_BREAKPOINT };
}
