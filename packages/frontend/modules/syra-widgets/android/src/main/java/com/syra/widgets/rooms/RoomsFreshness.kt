package com.syra.widgets.rooms

import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * How long a fetched batch of live rooms may still be believed.
 *
 * This is the whole reason a live-rooms widget is harder than a feed widget. A
 * feed row that is twenty minutes old is merely old; it was true when it was
 * written and it is still true now. "Live" is not like that — it is a claim
 * about the present, and it decays. A widget asserting that a room is live
 * twenty minutes after that room ended is not stale, it is WRONG, and it is
 * worse than a widget that admits it does not know: the reader taps through to
 * an empty room and learns not to trust the surface.
 *
 * So the batch's age is treated as part of the data, and the widget draws one of
 * three different things depending on it. The thresholds below are derived from
 * the refresh schedule rather than picked, because a policy that outlives its own
 * refresh cycle is how the wrong claim gets made in the first place.
 *
 * Everything here is pure arithmetic over a timestamp, so it is unit-testable
 * without a device, a launcher or a clock — which is the point, since this is the
 * file most likely to be wrong in a way nothing else would catch.
 */

/**
 * The periodic tick, in minutes. WorkManager's periodic floor is 15, so this is
 * as often as a periodic worker is allowed to run at all.
 */
internal const val REFRESH_INTERVAL_MINUTES = 15L

/** Flex window on the periodic tick — the worker may run this early. */
internal const val REFRESH_FLEX_MINUTES = 5L

/**
 * Past this age the widget stops stating a room is live without qualification
 * and starts saying when it last looked.
 *
 * Five minutes: short enough that the unqualified claim is nearly always true,
 * long enough that a widget glanced at repeatedly is not constantly hedging.
 */
internal val ROOMS_AGEING_AFTER_MS: Long = TimeUnit.MINUTES.toMillis(5)

/**
 * Past this age the widget stops claiming anything is live.
 *
 * Derived, not chosen: a batch this old means the periodic tick that should have
 * replaced it did not run — no network, Doze, the worker cancelled — so every
 * room in it may have ended without the widget ever hearing. At that point the
 * honest answer is that we do not know who is live, and the widget says so.
 *
 * Tied to the schedule so the two cannot drift apart: lengthen the interval and
 * this lengthens with it, which `RoomsFreshnessTest` asserts directly.
 */
internal val ROOMS_EXPIRED_AFTER_MS: Long =
    TimeUnit.MINUTES.toMillis(REFRESH_INTERVAL_MINUTES + REFRESH_FLEX_MINUTES)

internal enum class RoomsFreshness {
    /** Recent enough to say plainly that these rooms are live. */
    LIVE,

    /** Old enough that the claim is qualified with when it was taken. */
    AGEING,

    /** Older than a refresh cycle: nothing in it can be claimed as live. */
    EXPIRED,
}

/**
 * [fetchedAtMs] is compared by absolute difference, so a device whose clock moved
 * BACKWARDS since the fetch reads as old rather than as fresh forever. A
 * timestamp from the future is not evidence of freshness.
 */
internal fun roomsFreshness(fetchedAtMs: Long, nowMs: Long): RoomsFreshness {
    val age = abs(nowMs - fetchedAtMs)
    return when {
        age < ROOMS_AGEING_AFTER_MS -> RoomsFreshness.LIVE
        age < ROOMS_EXPIRED_AFTER_MS -> RoomsFreshness.AGEING
        else -> RoomsFreshness.EXPIRED
    }
}

/**
 * What the widget should draw, given what is stored and what time it is.
 *
 * One pure function so the decision is testable in isolation and the composable
 * has no policy in it at all — it renders whichever of these three it is handed.
 */
internal sealed interface LiveRoomsView {
    /**
     * Rooms to draw. [qualified] asks for the "as of N minutes ago" line, which
     * is what lets the widget keep showing useful content while being honest
     * that it is not a live reading.
     */
    data class Rooms(
        val rooms: List<WidgetRoom>,
        val ageMinutes: Int,
        val qualified: Boolean,
    ) : LiveRoomsView

    /** Looked recently, and nobody is live. A fact, not a failure. */
    data object NoneLive : LiveRoomsView

    /** Never looked, or looked too long ago to say. Not the same as nobody live. */
    data object Unknown : LiveRoomsView
}

internal fun liveRoomsView(stored: StoredRooms, nowMs: Long): LiveRoomsView {
    // A batch that has never been fetched is unknown even at age zero, which is
    // why this is checked before freshness rather than folded into it.
    if (stored.fetchedAtMs <= 0L) return LiveRoomsView.Unknown

    val freshness = roomsFreshness(stored.fetchedAtMs, nowMs)
    if (freshness == RoomsFreshness.EXPIRED) return LiveRoomsView.Unknown

    // An empty batch is only meaningful while it is believable. Once expired it
    // has already fallen through to Unknown above — "nobody is live" is as much
    // a claim about now as "these three are".
    if (stored.rooms.isEmpty()) return LiveRoomsView.NoneLive

    return LiveRoomsView.Rooms(
        rooms = stored.rooms,
        ageMinutes = ageMinutes(stored.fetchedAtMs, nowMs),
        qualified = freshness == RoomsFreshness.AGEING,
    )
}

/** Whole minutes since the fetch, floored at zero. */
internal fun ageMinutes(fetchedAtMs: Long, nowMs: Long): Int =
    TimeUnit.MILLISECONDS.toMinutes(abs(nowMs - fetchedAtMs)).toInt().coerceAtLeast(0)

/**
 * Whether a stored batch is due to be replaced.
 *
 * The worker ticks more often than the batch expires, so this is what stops
 * every tick becoming a network request. Anything at or past [ROOMS_AGEING_AFTER_MS]
 * is refetched — the widget aims to stay in the unqualified state, and only shows
 * its age when a refresh has actually failed to land.
 */
internal fun shouldFetchRooms(stored: StoredRooms, nowMs: Long): Boolean {
    if (stored.fetchedAtMs <= 0L) return true
    return abs(nowMs - stored.fetchedAtMs) >= ROOMS_AGEING_AFTER_MS
}
