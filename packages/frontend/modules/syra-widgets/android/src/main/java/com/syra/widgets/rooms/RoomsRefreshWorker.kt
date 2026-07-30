package com.syra.widgets.rooms

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONException
import java.io.IOException

/**
 * Refetch the live rooms and redraw.
 *
 * The tick runs more often than a batch goes stale, so [shouldFetchRooms] decides
 * whether this tick actually costs a request. Either way the widget is redrawn,
 * because its content depends on the CLOCK as well as on the data — a batch that
 * crossed into "ageing" or "expired" since the last draw has to be redrawn to say
 * so, with no new data involved at all.
 */
internal class RoomsRefreshWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {

    override suspend fun doWork(): Result {
        // Nothing placed: succeed without touching the network. `onDisabled`
        // cancels the schedule, but a job already queued can still land after it.
        if (!anyPlaced(applicationContext)) return Result.success()

        val stored = RoomsRepository.read(applicationContext)
        val now = System.currentTimeMillis()

        val outcome = if (shouldFetchRooms(stored, now)) fetchInto(now) else Result.success()

        LiveRoomsWidget().updateAll(applicationContext)
        return outcome
    }

    private suspend fun fetchInto(nowMs: Long): Result = try {
        // An empty result is stored as a real answer — see `RoomsRepository.save`.
        RoomsRepository.save(applicationContext, RoomsApi.fetch(applicationContext), nowMs)
        Result.success()
    } catch (cause: IOException) {
        // Transient: the network was unavailable or the server was unhappy. The
        // previous batch stays put and ages, which the widget renders honestly.
        //
        // Logged rather than only turned into a Result: a widget that quietly
        // stops updating is indistinguishable from one whose backend has nothing
        // to say, and this line is the only place the difference is visible.
        Log.w(TAG, "Live rooms refresh failed (attempt $runAttemptCount)", cause)
        if (runAttemptCount >= MAX_ATTEMPTS) Result.failure() else Result.retry()
    } catch (cause: JSONException) {
        // A contract break. Retrying fetches the same unparseable body, so this
        // fails rather than burning the backoff schedule on it.
        Log.e(TAG, "Live rooms response did not match the expected shape", cause)
        Result.failure()
    }

    private companion object {
        const val MAX_ATTEMPTS = 3
        const val TAG = "SyraLiveRoomsWidget"
    }
}

/** Whether any instance of the widget is currently on a home screen. */
internal fun anyPlaced(context: Context): Boolean {
    val manager = AppWidgetManager.getInstance(context) ?: return false
    return manager
        .getAppWidgetIds(ComponentName(context, LiveRoomsWidgetReceiver::class.java))
        .isNotEmpty()
}
