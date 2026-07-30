package com.syra.widgets.rooms

import androidx.compose.runtime.Composable
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.appwidget.components.TitleBar
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.Text
import com.syra.widgets.R
import com.syra.widgets.theme.LIVE_DOT_COLOR

/**
 * The whole widget, drawn from a [LiveRoomsView] the caller has already decided.
 *
 * No policy lives here: which of the three states applies is
 * [liveRoomsView]'s decision, tested on its own, and this file only renders
 * whichever it is handed. That split is what makes "what does the widget do when
 * its data outlives the content" answerable without a device.
 *
 * A plain `Box` with a `background` modifier rather than Glance's `Scaffold`,
 * because `Scaffold` applies a vertical padding it does not expose — which
 * [roomRowsThatFit] would then be wrong by. The launcher rounds widget corners
 * itself on API 31+.
 */
@Composable
internal fun LiveRoomsContent(view: LiveRoomsView) {
    val size = LocalSize.current
    val withTitleBar = showTitleBar(size.height)
    val compact = isCompact(size.width)

    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(android.R.dimen.system_app_widget_background_radius),
    ) {
        Column(modifier = GlanceModifier.fillMaxSize()) {
            if (withTitleBar) {
                LiveRoomsTitleBar(compact)
            } else {
                Spacer(GlanceModifier.height(RoomsWidgetDimensions.WIDGET_PADDING))
            }

            Box(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .padding(
                        start = RoomsWidgetDimensions.WIDGET_PADDING,
                        end = RoomsWidgetDimensions.WIDGET_PADDING,
                        bottom = RoomsWidgetDimensions.WIDGET_PADDING,
                    ),
            ) {
                when (view) {
                    is LiveRoomsView.Rooms -> RoomsList(
                        view = view,
                        rowCount = roomRowsThatFit(size.height, withTitleBar),
                        compact = compact,
                    )
                    LiveRoomsView.NoneLive -> MessageContent(R.string.syra_live_rooms_widget_none_live)
                    LiveRoomsView.Unknown -> MessageContent(R.string.syra_live_rooms_widget_unknown)
                }
            }
        }
    }
}

@Composable
private fun LiveRoomsTitleBar(compact: Boolean) {
    val context = LocalContext.current
    TitleBar(
        startIcon = ImageProvider(R.drawable.syra_widget_brand),
        // Dropped where the widget is too narrow to hold the mark, the title and
        // the action without crowding. The mark still says whose widget this is.
        title = if (compact) "" else context.getString(R.string.syra_live_rooms_widget_title),
        iconColor = GlanceTheme.colors.primary,
        textColor = GlanceTheme.colors.onSurface,
        actions = {
            CircleIconButton(
                imageProvider = ImageProvider(R.drawable.syra_widget_open),
                contentDescription = context.getString(R.string.syra_live_rooms_widget_open_live),
                contentColor = GlanceTheme.colors.secondary,
                backgroundColor = null,
                onClick = actionStartActivity(openInAppIntent(context, liveScreenUrl(context))),
            )
        },
    )
}

@Composable
private fun RoomsList(view: LiveRoomsView.Rooms, rowCount: Int, compact: Boolean) {
    val context = LocalContext.current

    // The "as of" line costs a row, so it is only shown where the widget has more
    // than one room's worth of height to give it. A single-row widget shows the
    // room instead — the qualification matters less than having any content at all.
    val showAsOf = view.qualified && rowCount > 1
    val roomRows = (if (showAsOf) rowCount - 1 else rowCount).coerceAtLeast(1)

    Column(modifier = GlanceModifier.fillMaxSize()) {
        for ((index, room) in view.rooms.take(roomRows).withIndex()) {
            if (index > 0) {
                Spacer(GlanceModifier.height(RoomsWidgetDimensions.ROW_SPACING))
            }
            RoomRow(room = room, compact = compact)
        }

        if (showAsOf) {
            Spacer(GlanceModifier.height(RoomsWidgetDimensions.ROW_SPACING))
            Text(
                text = asOfLine(context, view.ageMinutes),
                style = RoomsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun RoomRow(room: WidgetRoom, compact: Boolean) {
    val context = LocalContext.current

    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(RoomsWidgetDimensions.ROW_HEIGHT)
            .clickable(actionStartActivity(openInAppIntent(context, liveScreenUrl(context)))),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        // A filled circle drawn as a rounded-corner Box, because Glance has no
        // shape primitive and a one-colour dot does not justify a drawable.
        Box(
            modifier = GlanceModifier
                .size(RoomsWidgetDimensions.LIVE_DOT_SIZE)
                .background(LIVE_DOT_COLOR)
                .cornerRadius(RoomsWidgetDimensions.LIVE_DOT_SIZE),
            content = {},
        )
        Spacer(GlanceModifier.width(RoomsWidgetDimensions.LIVE_DOT_SPACING))

        Column(modifier = GlanceModifier.defaultWeight()) {
            Text(
                text = room.title,
                style = RoomsWidgetTextStyles.title(GlanceTheme.colors.onSurface, compact),
                maxLines = 1,
            )
            Text(
                text = roomSupportingLine(context, room, compact),
                style = RoomsWidgetTextStyles.supporting(GlanceTheme.colors.onSurfaceVariant),
                maxLines = 1,
            )
        }
    }
}

/**
 * The two content-free states.
 *
 * Deliberately no spinner: a widget that rests on a spinner looks broken every
 * time it is glanced at, and neither of these is a loading state — one is "nobody
 * is live", the other is "we cannot say who is".
 */
@Composable
private fun MessageContent(messageRes: Int) {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = context.getString(messageRes),
            style = RoomsWidgetTextStyles.emptyMessage(GlanceTheme.colors.onSurface),
            maxLines = 2,
        )
        Spacer(GlanceModifier.height(RoomsWidgetDimensions.EMPTY_CONTENT_SPACING))
        FilledButton(
            text = context.getString(R.string.syra_live_rooms_widget_open_app),
            onClick = actionStartActivity(openInAppIntent(context, liveScreenUrl(context))),
            maxLines = 1,
        )
    }
}
