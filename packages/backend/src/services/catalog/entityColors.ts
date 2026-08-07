export interface EntityColors {
  primaryColor?: string;
  secondaryColor?: string;
}

export interface EntityColorTarget {
  primaryColor?: string | null;
  secondaryColor?: string | null;
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

/**
 * The new image decides both accents, INCLUDING deciding they are absent.
 *
 * `?? null`, not bare `undefined`, and the difference is only visible once the
 * target is a drizzle `.set()`: drizzle drops an `undefined`-valued key
 * entirely, so `undefined` means "leave this column alone" where Mongoose's
 * `save()` cleared it. A replace that left the previous image's colours behind
 * would not be a replace.
 *
 * This module currently has NO importers — the shape it describes is
 * implemented inline in `podcasts.controller` and `uploads.controller`, both of
 * which had exactly this defect and were fixed by Task 13. Corrected here too
 * rather than left as a trap for whoever wires it next.
 */
export function replaceColors(
  target: EntityColorTarget,
  colors: EntityColors | undefined,
): void {
  target.primaryColor = colors?.primaryColor ?? null;
  target.secondaryColor = colors?.secondaryColor ?? null;
}
