package com.syra.widgets.rooms

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/**
 * The widget's measurements and type scale, kept apart from the composables that
 * use them because everything here can be wrong in a way a JVM test can catch and
 * nothing here needs a `Context` or a launcher to evaluate.
 *
 * Every dimension is taken from a source and cited. None is a guess.
 */
internal object RoomsWidgetDimensions {
    /**
     * Padding around the widget's content. `Scaffold` defaults `horizontalPadding`
     * to the same 12dp, and it is `ActionListLayoutDimensions.widgetPadding` in
     * Google's `android/platform-samples` app-widget sample.
     *
     * Applied by hand on a plain `Box` rather than by using `Scaffold`, because
     * `Scaffold` adds a vertical padding it does not expose — which the row
     * arithmetic below would then be wrong by.
     */
    val WIDGET_PADDING = 12.dp

    /** `ActionListLayoutDimensions.verticalSpacing` — the gap between rows. */
    val ROW_SPACING = 4.dp

    /**
     * One room's row height, and why: 48dp is Material's minimum touch target and
     * the whole row is one tap target. It doubles as the unit [roomRowsThatFit]
     * divides by, so the row count can never yield a row shorter than a finger.
     */
    val ROW_HEIGHT = 48.dp

    /**
     * Height `TitleBar` occupies: its start-icon `Box` is `size(48.dp)` and its
     * `Row` adds `padding(vertical = 4.dp)` (TitleBar.kt in
     * androidx.glance:glance-appwidget), so 48 + 4 + 4.
     */
    val TITLE_BAR_HEIGHT = 56.dp

    /**
     * Below this height the title bar is dropped in favour of content.
     * `ActionListLayoutSize.showTitleBar`'s own threshold, and 180dp is three
     * launcher cells under the `70 × n − 30` conversion in the App Widget sizing
     * guide.
     */
    val TITLE_BAR_MIN_HEIGHT = 180.dp

    /**
     * Below this width the widget goes compact: smaller type, and the topic drops
     * off the supporting line. Two launcher cells (`70 × 2 − 30`).
     */
    val COMPACT_MAX_WIDTH = 180.dp

    /** Diameter of the live dot. Matches the supporting line's cap height at 12sp. */
    val LIVE_DOT_SIZE = 8.dp

    /** Gap between the live dot and the text it marks. */
    val LIVE_DOT_SPACING = 6.dp

    /** Gap between an empty state's message and its button; `NoDataContent`'s. */
    val EMPTY_CONTENT_SPACING = 8.dp
}

internal object RoomsWidgetFontSizes {
    /** M3 Title Medium / Title Small — a room's title. */
    const val TITLE = 16f
    const val TITLE_COMPACT = 14f

    /** M3 Label Medium — listener count, topic, the "as of" line. */
    const val SUPPORTING = 12f

    /** M3 Title Medium — an empty state's single line. */
    const val EMPTY_MESSAGE = 16f
}

internal object RoomsWidgetTextStyles {
    fun title(color: ColorProvider, compact: Boolean) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = if (compact) {
            RoomsWidgetFontSizes.TITLE_COMPACT.sp
        } else {
            RoomsWidgetFontSizes.TITLE.sp
        },
    )

    fun supporting(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Normal,
        fontSize = RoomsWidgetFontSizes.SUPPORTING.sp,
    )

    fun emptyMessage(color: ColorProvider) = TextStyle(
        color = color,
        fontWeight = FontWeight.Medium,
        fontSize = RoomsWidgetFontSizes.EMPTY_MESSAGE.sp,
    )
}

/**
 * How many room rows fit in a widget this tall.
 *
 * Derived rather than tabulated: `n` rows need `n × ROW_HEIGHT` plus the `(n − 1)`
 * gaps between them, inside whatever the title bar and padding leave. That makes
 * every breakpoint a consequence of the cited constants instead of a table someone
 * has to keep in step with them, and it still answers for a size the launcher
 * hands over that no breakpoint declared.
 *
 * Capped at [MAX_STORED_ROOMS] because nothing beyond that is ever stored, and
 * floored at one: a widget too short for a row still has to draw something.
 *
 * The cap is also what bounds the `RemoteViews` transaction. This widget draws no
 * bitmaps at all — a room is a title, a topic and a count, and Syra's rooms carry
 * an optional `streamImage` that most do not set, so an image-led layout would be
 * mostly placeholders. Text-only means the whole parcel is a small view tree plus
 * at most [MAX_STORED_ROOMS] short strings, which cannot approach the 1MB Binder
 * limit that blanks a bitmap-heavy widget.
 */
internal fun roomRowsThatFit(widgetHeight: Dp, showTitleBar: Boolean): Int {
    val chrome = with(RoomsWidgetDimensions) {
        (if (showTitleBar) TITLE_BAR_HEIGHT else WIDGET_PADDING) + WIDGET_PADDING
    }
    val available = widgetHeight - chrome
    val pitch = RoomsWidgetDimensions.ROW_HEIGHT + RoomsWidgetDimensions.ROW_SPACING

    return ((available + RoomsWidgetDimensions.ROW_SPACING) / pitch)
        .toInt()
        .coerceIn(1, MAX_STORED_ROOMS)
}

/** Whether a widget this tall has room for the title bar. */
internal fun showTitleBar(widgetHeight: Dp): Boolean =
    widgetHeight >= RoomsWidgetDimensions.TITLE_BAR_MIN_HEIGHT

/** Whether a widget this wide has to drop secondary content. */
internal fun isCompact(widgetWidth: Dp): Boolean =
    widgetWidth < RoomsWidgetDimensions.COMPACT_MAX_WIDTH
