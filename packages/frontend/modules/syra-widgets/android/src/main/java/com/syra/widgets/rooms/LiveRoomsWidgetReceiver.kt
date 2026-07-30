package com.syra.widgets.rooms

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

class LiveRoomsWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = LiveRoomsWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RoomsRefreshScheduler.ensureScheduled(context)
        // The periodic tick may be up to fifteen minutes away; a widget just
        // placed should not be empty for that long.
        RoomsRefreshScheduler.refreshNow(context)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        // Re-asserted here rather than only in `onEnabled` because the schedule
        // does not survive every path that gets us here — an app update or a
        // restore leaves widgets placed with nothing enqueued. `KEEP` makes this
        // free when a schedule already exists.
        RoomsRefreshScheduler.ensureScheduled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Last instance removed: leave nothing running.
        RoomsRefreshScheduler.cancel(context)
    }
}
