package com.syra.widgets.rooms

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.state.GlanceStateDefinition
import com.syra.widgets.theme.SyraGlanceTheme
import kotlinx.coroutines.flow.first

internal class LiveRoomsWidget : GlanceAppWidget() {

    /**
     * `SizeMode.Exact`, not `Responsive`.
     *
     * `Responsive(sizes)` composes once PER DECLARED SIZE and packs every result
     * into the same `RemoteViews`, and `LocalSize` then reports the matched
     * declared size rather than the real one — so `roomRowsThatFit` would be
     * computed against a size the widget is not. `Exact` composes for the size
     * the HOST reports (`AppWidgetManager.OPTION_APPWIDGET_SIZES` on API 31+),
     * which is the size actually being drawn.
     *
     * The cost is a recomposition on resize, which is cheap here: content is a
     * local DataStore read, never a network call.
     */
    override val sizeMode: SizeMode = SizeMode.Exact

    /** State comes from `RoomsRepository`, not from Glance's own store. */
    override val stateDefinition: GlanceStateDefinition<*>? = null

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val stored = RoomsRepository.stored(context)
        val initial = stored.first()

        provideContent {
            val current by stored.collectAsState(initial = initial)

            // The clock is read at composition rather than captured once, so a
            // redraw triggered by the worker re-evaluates freshness against the
            // time it is actually being drawn.
            SyraGlanceTheme {
                LiveRoomsContent(liveRoomsView(current, System.currentTimeMillis()))
            }
        }
    }
}
