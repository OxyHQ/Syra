package com.syra.widgets.theme

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.glance.GlanceComposable
import androidx.glance.GlanceTheme
// Two different `ColorProvider`s, and this is the one that matters here:
// `androidx.glance.color` is the day/night FACTORY, `androidx.glance.unit` is the
// type it produces. Same split as androidx.glance:glance-material3's own theme.
import androidx.glance.color.ColorProvider
import androidx.glance.color.ColorProviders
import androidx.glance.color.colorProviders

/**
 * The widget's colours.
 *
 * On API 31+ the launcher's own Material You palette is used, so the widget sits
 * with the rest of the home screen rather than fighting it — which is the
 * platform convention and what a reader expects. Below that there is no dynamic
 * palette, so Syra's own is used instead.
 */
@Composable
fun SyraGlanceTheme(content: @GlanceComposable @Composable () -> Unit) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        GlanceTheme(content = content)
    } else {
        GlanceTheme(colors = SyraWidgetColors, content = content)
    }
}

/**
 * GENERATED, not authored — do not hand-edit a value here.
 *
 * Every role below is Bloom's own colour engine (`generateRoleColors` from
 * `@oxyhq/bloom/theme/color-engine`) resolving Syra's actual preset seed
 * `#8b5cf6` at variant `vivid` — the `purple` preset that `app/_layout.tsx`
 * passes as `defaultColorPreset` — in light and dark. Regenerate from the seed
 * rather than nudging a hex, or the widget drifts away from the app it belongs
 * to.
 *
 * `widgetBackground` is not an M3 role the engine emits: glance-material3 derives
 * it from `secondaryContainer` by an HCT tone shift (+5 light, −10 dark), and the
 * two values here are that derivation applied to the generated pair.
 */
internal val SyraWidgetColors: ColorProviders = colorProviders(
    primary = ColorProvider(day = Color(0xFF7114FF), night = Color(0xFFD0BCFF)),
    onPrimary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF3C0091)),
    primaryContainer = ColorProvider(day = Color(0xFFE9DDFF), night = Color(0xFF5600CA)),
    onPrimaryContainer = ColorProvider(day = Color(0xFF5600CA), night = Color(0xFFE9DDFF)),
    inversePrimary = ColorProvider(day = Color(0xFFD0BCFF), night = Color(0xFF7114FF)),
    secondary = ColorProvider(day = Color(0xFF833CB4), night = Color(0xFFE3B5FF)),
    onSecondary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF4D007A)),
    secondaryContainer = ColorProvider(day = Color(0xFFF3DAFF), night = Color(0xFF691E9A)),
    onSecondaryContainer = ColorProvider(day = Color(0xFF691E9A), night = Color(0xFFF3DAFF)),
    tertiary = ColorProvider(day = Color(0xFF9A29A6), night = Color(0xFFFEA9FF)),
    onTertiary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF580062)),
    tertiaryContainer = ColorProvider(day = Color(0xFFFFD6FB), night = Color(0xFF7D008B)),
    onTertiaryContainer = ColorProvider(day = Color(0xFF7D008B), night = Color(0xFFFFD6FB)),
    error = ColorProvider(day = Color(0xFFBA1A1A), night = Color(0xFFFFB4AB)),
    onError = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF690005)),
    errorContainer = ColorProvider(day = Color(0xFFFFDAD6), night = Color(0xFF93000A)),
    onErrorContainer = ColorProvider(day = Color(0xFF93000A), night = Color(0xFFFFDAD6)),
    background = ColorProvider(day = Color(0xFFFEF7FF), night = Color(0xFF15121C)),
    onBackground = ColorProvider(day = Color(0xFF1D1A24), night = Color(0xFFE7E0EE)),
    surface = ColorProvider(day = Color(0xFFFEF7FF), night = Color(0xFF15121C)),
    onSurface = ColorProvider(day = Color(0xFF1D1A24), night = Color(0xFFE7E0EE)),
    surfaceVariant = ColorProvider(day = Color(0xFFE8DFF2), night = Color(0xFF494453)),
    onSurfaceVariant = ColorProvider(day = Color(0xFF494453), night = Color(0xFFCBC3D5)),
    outline = ColorProvider(day = Color(0xFF7A7484), night = Color(0xFF948E9F)),
    inverseSurface = ColorProvider(day = Color(0xFF322F3A), night = Color(0xFFE7E0EE)),
    inverseOnSurface = ColorProvider(day = Color(0xFFF6EEFD), night = Color(0xFF322F3A)),
    widgetBackground = ColorProvider(day = Color(0xFFFBECFF), night = Color(0xFF4E007A)),
)

/**
 * The live dot's colour, fixed rather than themed.
 *
 * "Live" is a status, and a status indicator that Material You might recolour to
 * whatever the wallpaper suggests stops reading as one — a pale lilac dot beside
 * a room title says nothing. This red is the same signal every streaming surface
 * uses, and it holds its meaning against any palette the launcher applies.
 */
internal val LIVE_DOT_COLOR = ColorProvider(day = Color(0xFFE0243B), night = Color(0xFFFF5A6E))
