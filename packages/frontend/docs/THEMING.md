# Theming: className tokens, not inline colours

Syra reads Bloom's palette into inline styles. Mention, the working reference in
the same ecosystem, uses NativeWind classes. Measured 2026-08-08 across both
frontends:

| | `theme.colors.*` reads | className token usages |
|---|---|---|
| **Syra** | **843** | **26** |
| **Mention** | 663 | **896** |

`~/AGENTS.md` is explicit — *"NativeWind className-based theming only — no custom
color props, wrapper components, or Reanimated color approaches"* — and the
consequence is not stylistic: **a token system reaches a screen only through class
names.** Bloom can retune a preset, ship a new colour engine or scope a subtree
with `BloomColorScope`, and a screen painted from `style={{ color: theme.colors.text }}`
will not follow it, because the value was read once at render and frozen into a
style object.

## The mapping

Authoritative, read out of Bloom's own `src/theme/build-theme.ts` rather than
inferred from names — several are not what the name suggests:

| `theme.colors.X` | Bloom token | class | sites |
|---|---|---|---|
| `text` | `foreground` | `text-foreground` | 184 |
| `textSecondary` | `muted-foreground` | `text-muted-foreground` | 241 |
| `background` | `background` | `bg-background` | 17 |
| `backgroundSecondary` | **`surface`** | `bg-surface` | 127 |
| `backgroundTertiary` | **`popover`** | `bg-popover` | 38 |
| `border` | `border` | `border-border` | 36 |
| `primary` | `primary` | `bg-primary` / `text-primary` | 126 |
| `primaryForeground` | `primary-foreground` | `text-primary-foreground` | 61 |
| `card` | `card` | `bg-card` | 11 |
| `error` | status colour | `text-error` / `bg-error` | 24 |

**`backgroundSecondary` → `surface` and `backgroundTertiary` → `popover` are the
two nobody guesses.** Mapping them to `bg-secondary`/`bg-muted` by name compiles,
renders, and is wrong — a silent palette change no test can see.

## What legitimately stays an inline colour

**Icon `color=` props.** An icon component takes a colour prop, not a className,
so `color={theme.colors.textSecondary}` is correct and Mention keeps ~161 of its
own. This is the one place reading the theme is right.

The convertible set is therefore **~485 sites**, not 843:

```
backgroundColor: theme.colors.X   178
color: theme.colors.X             280
borderColor: theme.colors.X        27
```

## The trap to avoid while converting

From Bloom's `AGENTS.md`, and it is invisible: **never append a hex alpha to a
Bloom colour token in an inline style.** Accent roles resolve to `rgb(...)`, so
`` `${theme.colors.primary}1A` `` produces a malformed string that
react-native-web parses back as fully **opaque** — a tinted control whose label
uses the same token paints text on an identical background, contrast ratio 1.00.
Use the opacity class instead: `bg-primary/10` with `text-primary`.

Syra has zero of these today only because it barely uses tokens at all, so this is
a hazard the conversion can *introduce*.

## Verification that actually means something

Bloom's own standard, and it applies here: a check confirming a background style
exists cannot tell a correctly tinted control from an invisible one. **Composite
the control's background over what is behind it, read the label colour, and
compute the WCAG contrast ratio** — assert the property a person perceives, not
the property you changed.

And verify in a real, FOREGROUNDED browser tab. A backgrounded tab freezes CSS
transitions, so a computed style stays at its from-value forever and mimics "the
className never applied".

## Status — the conversion is done

**485 convertible sites -> 2.** Both survivors are in
`context/BottomSheetContext.tsx`, and they are CORRECT: `backgroundStyle` and
`handleIndicatorStyle` belong to `@gorhom/bottom-sheet`, a third-party component
whose props take style objects. Reading the theme there is the right thing, the
same category as an icon's `color=` prop (187 of those, all legitimate).

className token usages went 26 -> ~470.

Shapes that needed a human rather than the transformer, in case the next one
looks similar:

- colours living inside a `StyleSheet.create` built from `theme` in a `useMemo`
  (`OfflineBanner`, `PlayerBar`, `app/_layout.tsx`);
- colours threaded through a PROP to a child (`EmptyState` took 17 of these; it
  now accepts `className` and defaults to `bg-background`);
- a colour chosen by a `pressed`/`isActive` condition, which becomes either a
  conditional class or an `active:` variant;
- objects carrying several properties at once, where only some are colours.

One hazard confirmed the hard way: converting `app/live.tsx` by hand produced TWO
`className` attributes on one element. `tsc` caught it (TS17001) only because JSX
forbids duplicates — the same mistake inside a style array is legal and silent,
which is why the transformer merges into an existing `className` instead of
appending a second.

## Version status

`@oxyhq/bloom` is on **0.89.0** (`e1ee4b0`) — the bump needed the root `overrides`
entry moved too, because a caret on a 0.x line is minor-locked and `bun install`
otherwise reports "no changes" while leaving the tree behind.

The conversion is staged by surface. Each stage should be reviewable on its own,
and no stage should ship without someone looking at the screen it changed.
