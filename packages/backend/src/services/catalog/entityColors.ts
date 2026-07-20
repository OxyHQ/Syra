export interface EntityColors {
  primaryColor?: string;
  secondaryColor?: string;
}

export interface EntityColorTarget {
  primaryColor?: string;
  secondaryColor?: string;
}

export function assignMissingColors(
  target: EntityColorTarget,
  colors: EntityColors | undefined,
): void {
  if (colors?.primaryColor && !target.primaryColor) {
    target.primaryColor = colors.primaryColor;
  }
  if (colors?.secondaryColor && !target.secondaryColor) {
    target.secondaryColor = colors.secondaryColor;
  }
}

export function replaceColors(
  target: EntityColorTarget,
  colors: EntityColors | undefined,
): void {
  target.primaryColor = colors?.primaryColor;
  target.secondaryColor = colors?.secondaryColor;
}
