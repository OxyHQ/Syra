package com.syra.widgets.rooms

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.TimeUnit

/**
 * When the widget refetches.
 *
 * Two unique jobs, on purpose:
 *
 *  - the PERIODIC tick, at WorkManager's 15-minute floor, which is the fastest a
 *    periodic worker is permitted to run;
 *  - an IMMEDIATE one-off, so placing the widget or a nudge from the app does not
 *    wait up to fifteen minutes for its first content.
 *
 * There is deliberately no self-rescheduling chain of delayed one-off requests
 * here, even though that is how a widget beats the periodic floor. A chain like
 * that has to be gated on `PowerManager.isInteractive` to avoid waking a sleeping
 * device every minute — which means it stops exactly when the screen is off, and
 * a widget is only ever read with the screen ON. So the chain would buy a faster
 * refresh precisely when nobody is looking, at the cost of a permanently queued
 * job. The freshness policy handles the gap instead: between ticks the widget
 * shows its age rather than pretending, and past a missed tick it stops claiming
 * anything is live. Being honest about latency is cheaper than chasing it.
 */
internal object RoomsRefreshScheduler {
    private const val PERIODIC_WORK_NAME = "syra-widget-live-rooms-periodic"
    private const val IMMEDIATE_WORK_NAME = "syra-widget-live-rooms-immediate"

    private val NETWORK_REQUIRED = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * `KEEP` rather than `REPLACE`: this is called from every `onUpdate`, not just
     * `onEnabled`, and `REPLACE` would restart the interval each time — a widget
     * the launcher updates often would never reach its own period.
     */
    fun ensureScheduled(context: Context) {
        val request = PeriodicWorkRequestBuilder<RoomsRefreshWorker>(
            REFRESH_INTERVAL_MINUTES, TimeUnit.MINUTES,
            REFRESH_FLEX_MINUTES, TimeUnit.MINUTES,
        )
            .setConstraints(NETWORK_REQUIRED)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** `REPLACE` so a burst of nudges collapses into one fetch. */
    fun refreshNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<RoomsRefreshWorker>()
            .setConstraints(NETWORK_REQUIRED)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(IMMEDIATE_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /** Called when the last instance is removed, so nothing is left running. */
    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        workManager.cancelUniqueWork(PERIODIC_WORK_NAME)
        workManager.cancelUniqueWork(IMMEDIATE_WORK_NAME)
    }
}
