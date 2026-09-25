import React, { type ComponentProps } from 'react';
// The SUBPATH, never the `@expo/vector-icons` barrel: the barrel re-exports every
// icon family, so one glyph through it drags every family's font into a web
// bundle.
import BaseMaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

export type MaterialCommunityIconsProps = ComponentProps<typeof BaseMaterialCommunityIcons>;

/**
 * The live-rooms UI's one entry to the MaterialCommunityIcons glyph font. SDK
 * components import this, never `@expo/vector-icons/MaterialCommunityIcons`
 * directly — `src/live/icons/glyphImports.test.ts` fails the suite if one does.
 *
 * A vector-icons glyph is a `Text` node whose content is a private-use code
 * point. A screen reader reads it like any other text, so the Create Room sheet
 * announced its options as "\U000f036c, Talk, Open conversation" and its button
 * as "\U000f040a, Start Now": on Android RN builds an unlabelled pressable's
 * description from its children's text, code point included.
 *
 * Every glyph in the SDK is decorative — the control around it carries the
 * words, or an `accessibilityLabel` — so the glyph is hidden from assistive
 * technology here, once, rather than at each call site where the next icon
 * would forget it. `aria-hidden` is `importantForAccessibility=
 * "no-hide-descendants"` on Android, `accessibilityElementsHidden` on iOS and
 * `aria-hidden` on web. It is applied AFTER the caller's props so a call site
 * cannot switch it back on: a glyph that needs a name belongs inside a control
 * that has one.
 */
export function MaterialCommunityIcons(props: MaterialCommunityIconsProps) {
  return <BaseMaterialCommunityIcons {...props} aria-hidden />;
}

export default MaterialCommunityIcons;
