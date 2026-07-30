package com.syra.widgets.rooms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * The staleness policy — the one thing a live-rooms widget has to get right that
 * a feed widget does not. "Live" is a claim about the present, so these tests are
 * written at the boundaries where the claim changes, not at one happy value.
 */
class RoomsFreshnessTest {

    private companion object {
        val NOW = TimeUnit.DAYS.toMillis(20_000)

        val ROOMS = listOf(
            WidgetRoom(id = "1", title = "Late night listening", topic = "Music", listeners = 12),
        )

        fun stored(ageMs: Long, rooms: List<WidgetRoom> = ROOMS) =
            StoredRooms(rooms = rooms, fetchedAtMs = NOW - ageMs)
    }

    @Test
    fun `a batch just fetched is live`() {
        assertEquals(RoomsFreshness.LIVE, roomsFreshness(NOW, NOW))
        assertEquals(
            RoomsFreshness.LIVE,
            roomsFreshness(NOW - ROOMS_AGEING_AFTER_MS + 1, NOW),
        )
    }

    @Test
    fun `at the ageing threshold the claim starts being qualified`() {
        assertEquals(
            RoomsFreshness.AGEING,
            roomsFreshness(NOW - ROOMS_AGEING_AFTER_MS, NOW),
        )
        assertEquals(
            RoomsFreshness.AGEING,
            roomsFreshness(NOW - ROOMS_EXPIRED_AFTER_MS + 1, NOW),
        )
    }

    @Test
    fun `at the expiry threshold nothing can be claimed live any more`() {
        assertEquals(
            RoomsFreshness.EXPIRED,
            roomsFreshness(NOW - ROOMS_EXPIRED_AFTER_MS, NOW),
        )
        assertEquals(
            RoomsFreshness.EXPIRED,
            roomsFreshness(NOW - TimeUnit.HOURS.toMillis(6), NOW),
        )
    }

    @Test
    fun `expiry outlasts a refresh cycle, so one late tick does not blank the widget`() {
        // The policy is derived from the schedule rather than picked. If the
        // interval ever grows past the expiry window, every reader would see
        // "we don't know" between every pair of successful ticks.
        val refreshWindowMs = TimeUnit.MINUTES.toMillis(REFRESH_INTERVAL_MINUTES + REFRESH_FLEX_MINUTES)
        assertTrue(
            "expiry ($ROOMS_EXPIRED_AFTER_MS ms) must not be shorter than one refresh window ($refreshWindowMs ms)",
            ROOMS_EXPIRED_AFTER_MS >= refreshWindowMs,
        )
        assertTrue(ROOMS_AGEING_AFTER_MS < ROOMS_EXPIRED_AFTER_MS)
    }

    @Test
    fun `a timestamp from the future is treated as old, not as fresh forever`() {
        // A device whose clock jumped backwards must not pin the widget into
        // claiming rooms are live indefinitely.
        assertEquals(
            RoomsFreshness.EXPIRED,
            roomsFreshness(NOW + TimeUnit.HOURS.toMillis(6), NOW),
        )
    }

    @Test
    fun `a fresh batch of rooms is shown without qualification`() {
        val view = liveRoomsView(stored(ageMs = 0), NOW)
        assertTrue(view is LiveRoomsView.Rooms)
        assertFalse((view as LiveRoomsView.Rooms).qualified)
        assertEquals(ROOMS, view.rooms)
    }

    @Test
    fun `an ageing batch is still shown, but says when it was taken`() {
        val view = liveRoomsView(stored(ageMs = TimeUnit.MINUTES.toMillis(8)), NOW)
        assertTrue(view is LiveRoomsView.Rooms)
        assertTrue((view as LiveRoomsView.Rooms).qualified)
        assertEquals(8, view.ageMinutes)
    }

    @Test
    fun `an expired batch shows unknown rather than rooms that may have ended`() {
        // The whole point: a room that ended twenty minutes ago must not still be
        // drawn as live.
        assertEquals(
            LiveRoomsView.Unknown,
            liveRoomsView(stored(ageMs = TimeUnit.HOURS.toMillis(1)), NOW),
        )
    }

    @Test
    fun `never fetched is unknown, not none-live`() {
        // These are different facts and the widget says different things for
        // them. Collapsing them would have a fresh install assert that nobody on
        // Syra is live, having never asked.
        assertEquals(LiveRoomsView.Unknown, liveRoomsView(StoredRooms.NEVER_FETCHED, NOW))
    }

    @Test
    fun `never fetched is unknown even when the clock cannot tell it is old`() {
        // The case above passes for the WRONG reason on a normal clock: a
        // `fetchedAtMs` of 0 is ~57 years old, so the expiry rule catches it
        // whether or not the never-fetched guard exists. Verified by deleting
        // that guard — every test still passed.
        //
        // Here the device clock is a second past the epoch, so age is ~1s and
        // freshness says LIVE. Only the explicit guard keeps a widget that has
        // never asked from announcing that nobody is live. Devices really do
        // boot with an unset clock before NTP lands, which is exactly when a
        // just-placed widget draws for the first time.
        assertEquals(
            LiveRoomsView.Unknown,
            liveRoomsView(StoredRooms.NEVER_FETCHED, nowMs = 1_000L),
        )
    }

    @Test
    fun `a recent empty batch is none-live, which is a real answer`() {
        assertEquals(
            LiveRoomsView.NoneLive,
            liveRoomsView(stored(ageMs = 0, rooms = emptyList()), NOW),
        )
    }

    @Test
    fun `an expired empty batch is unknown, because nobody-live also goes stale`() {
        assertEquals(
            LiveRoomsView.Unknown,
            liveRoomsView(stored(ageMs = TimeUnit.HOURS.toMillis(2), rooms = emptyList()), NOW),
        )
    }

    @Test
    fun `a batch is refetched once it starts ageing, not once it expires`() {
        assertTrue(shouldFetchRooms(StoredRooms.NEVER_FETCHED, NOW))
        assertFalse(shouldFetchRooms(stored(ageMs = 0), NOW))
        assertFalse(shouldFetchRooms(stored(ageMs = ROOMS_AGEING_AFTER_MS - 1), NOW))
        assertTrue(shouldFetchRooms(stored(ageMs = ROOMS_AGEING_AFTER_MS), NOW))
        // Aiming to refetch before the qualified state is even reached is what
        // keeps the widget normally showing an unqualified claim.
        assertTrue(ROOMS_AGEING_AFTER_MS < ROOMS_EXPIRED_AFTER_MS)
    }

    @Test
    fun `age in minutes floors rather than rounds, and never goes negative`() {
        assertEquals(0, ageMinutes(NOW - TimeUnit.SECONDS.toMillis(59), NOW))
        assertEquals(1, ageMinutes(NOW - TimeUnit.SECONDS.toMillis(119), NOW))
        assertEquals(0, ageMinutes(NOW + TimeUnit.SECONDS.toMillis(30), NOW))
    }
}
