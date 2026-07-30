package com.syra.widgets.rooms

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.syra.widgets.R
import java.util.Locale

/**
 * Turning stored rooms into the strings and intents the layout draws.
 *
 * Localized through Android resources rather than the app's i18n runtime, which
 * is not loaded in the launcher's process — the widget renders in the system
 * language on its own.
 */

internal fun apiBaseUrl(context: Context): String =
    context.getString(R.string.syra_widget_api_base_url).trimEnd('/')

internal fun webBaseUrl(context: Context): String =
    context.getString(R.string.syra_widget_web_base_url).trimEnd('/')

/**
 * The Live screen — every tap target on this widget leads here.
 *
 * Syra has no per-room route: a room is entered through the in-app engine's dock
 * (`useLiveRoom().joinLiveRoom`, see `app/live.tsx`), not by navigating to a URL.
 * So deep-linking a specific room would mean inventing a route and an auto-join
 * param in the app, which is a change to the app rather than to its widget.
 * Pointing every row at the list the reader was already looking at is the honest
 * target, and it is one tap from joining.
 */
internal fun liveScreenUrl(context: Context): String = "${webBaseUrl(context)}/live"

/**
 * `setPackage` keeps the tap inside Syra rather than offering a browser chooser;
 * `syra.fm` is an autoVerify'd app link, so the intent resolves to the app.
 */
internal fun openInAppIntent(context: Context, url: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/**
 * The supporting line under a room's title — "12 listening · Music", or just the
 * count where the widget is too narrow for both.
 *
 * A room with nobody in it yet says "Live" rather than "0 listening", which reads
 * as broken for a room that has genuinely just started.
 */
internal fun roomSupportingLine(context: Context, room: WidgetRoom, compact: Boolean): String {
    val listeners = if (room.listeners > 0) {
        context.resources.getQuantityString(
            R.plurals.syra_live_rooms_widget_listeners,
            room.listeners,
            formatCompactCount(room.listeners),
        )
    } else {
        context.getString(R.string.syra_live_rooms_widget_just_started)
    }

    val topic = room.topic
    return if (compact || topic.isNullOrEmpty()) {
        listeners
    } else {
        context.getString(R.string.syra_live_rooms_widget_supporting_pair, listeners, topic)
    }
}

/**
 * "as of 8 min ago" — shown only once a batch has aged past the point where the
 * widget will state plainly that these rooms are live.
 */
internal fun asOfLine(context: Context, ageMinutes: Int): String =
    context.resources.getQuantityString(
        R.plurals.syra_live_rooms_widget_as_of,
        ageMinutes,
        ageMinutes,
    )

/**
 * 1_200 → "1.2K". Kept to one decimal so a count never widens the row enough to
 * push the title's ellipsis around as it changes.
 */
internal fun formatCompactCount(count: Int): String = when {
    count < 1_000 -> count.toString()
    count < 1_000_000 -> trimTrailingZero(count / 1_000.0) + "K"
    else -> trimTrailingZero(count / 1_000_000.0) + "M"
}

private fun trimTrailingZero(value: Double): String =
    String.format(Locale.US, "%.1f", value).removeSuffix(".0")
