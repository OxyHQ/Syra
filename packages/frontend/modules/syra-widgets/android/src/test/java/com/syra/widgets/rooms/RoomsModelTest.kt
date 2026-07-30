package com.syra.widgets.rooms

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parser is written against a real production response — the body below is
 * the shape `GET https://api.syra.fm/api/rooms` actually returns, fields and all,
 * not an invented one.
 */
class RoomsModelTest {

    private companion object {
        val REAL_RESPONSE = """
            {"rooms":[{"_id":"6a47e96948842c36b38f8267","title":"This is another test",
            "ownerType":"profile","host":"6981c9178fcdefaf81988ffb","houseId":null,
            "createdByAdmin":null,"type":"broadcast","broadcastKind":"user","status":"live",
            "speakerPermission":"invited","participants":["a","b","c"],
            "speakers":["6981c9178fcdefaf81988ffb"],"maxParticipants":100,"topic":"News",
            "tags":[],"archived":false,"seriesId":null,
            "stats":{"peakListeners":9,"totalJoined":14},"recordingEnabled":false,
            "recordingEgressId":null,"streamTitle":null,"streamImage":null,
            "streamDescription":null,"streamStartedAt":null,"streamDurationSec":null,
            "createdAt":"2026-07-03T16:55:05.595Z","updatedAt":"2026-07-13T15:29:19.217Z"}],
            "hasMore":false}
        """.trimIndent()
    }

    @Test
    fun `parses a real production room`() {
        val rooms = parseRoomsResponse(REAL_RESPONSE)
        assertEquals(1, rooms.size)
        assertEquals("6a47e96948842c36b38f8267", rooms[0].id)
        assertEquals("This is another test", rooms[0].title)
        assertEquals("News", rooms[0].topic)
    }

    @Test
    fun `listeners counts who is in the room now, not the all-time peak`() {
        // `participants` has 3, `stats.peakListeners` has 9. Reading the peak
        // would overstate a room that has emptied out — the number a reader
        // decides to tap on has to be the current one.
        assertEquals(3, parseRoomsResponse(REAL_RESPONSE)[0].listeners)
    }

    @Test
    fun `an empty room list parses to no rooms rather than throwing`() {
        assertEquals(emptyList<WidgetRoom>(), parseRoomsResponse("""{"rooms":[],"hasMore":false}"""))
    }

    @Test
    fun `a room with no id or no title is skipped, not fatal to the batch`() {
        val body = """
            {"rooms":[
              {"_id":"","title":"No id"},
              {"_id":"2","title":"   "},
              {"_id":"3","title":"Usable","participants":[]}
            ]}
        """.trimIndent()
        val rooms = parseRoomsResponse(body)
        assertEquals(1, rooms.size)
        assertEquals("3", rooms[0].id)
    }

    @Test
    fun `an absent topic is null rather than an empty string`() {
        val rooms = parseRoomsResponse("""{"rooms":[{"_id":"1","title":"T","participants":[]}]}""")
        assertNull(rooms[0].topic)
    }

    @Test
    fun `an explicit JSON null topic is null, not the word "null"`() {
        // HONEST NOTE, so nobody trusts this test to be the guard it looks like:
        // it passes with OR without `optTrimmed`'s `isNull` check, because the
        // Maven `org.json` on this classpath already returns "" for an explicit
        // null while Android's returns "null" (see the comment on `optTrimmed`).
        // The real defect — "Just started · null" drawn on a home screen — was
        // caught by looking at a device, and can only be caught that way.
        //
        // This test still earns its place: it fixes the intended CONTRACT, so a
        // future rewrite of the parser has something to satisfy, and it fails on
        // any implementation that returns a non-null topic here.
        val rooms = parseRoomsResponse(
            """{"rooms":[{"_id":"1","title":"T","topic":null,"participants":[]}]}""",
        )
        assertNull(rooms[0].topic)
    }

    @Test
    fun `a room whose id or title is explicitly null is skipped, not titled "null"`() {
        // Same trap one field over, where it would be drawn as a room called
        // "null" rather than dropped.
        val body = """
            {"rooms":[
              {"_id":null,"title":"No id","participants":[]},
              {"_id":"2","title":null,"participants":[]},
              {"_id":"3","title":"Usable","participants":[]}
            ]}
        """.trimIndent()
        val rooms = parseRoomsResponse(body)
        assertEquals(1, rooms.size)
        assertEquals("Usable", rooms[0].title)
    }

    @Test
    fun `a stored blob with explicit nulls decodes the same way`() {
        assertNull(decodeRooms("""[{"id":"1","title":"T","topic":null}]""")[0].topic)
        assertEquals(emptyList<WidgetRoom>(), decodeRooms("""[{"id":null,"title":"T"}]"""))
    }

    @Test(expected = JSONException::class)
    fun `a body that is not the documented shape throws, so the worker can stop retrying`() {
        parseRoomsResponse("""{"unexpected":true}""")
    }

    @Test
    fun `the stored batch is capped however many rooms the API returns`() {
        val many = (1..50).joinToString(",") { """{"_id":"$it","title":"Room $it","participants":[]}""" }
        assertEquals(MAX_STORED_ROOMS, parseRoomsResponse("""{"rooms":[$many]}""").size)
    }

    @Test
    fun `encode then decode round-trips every drawn field`() {
        val rooms = listOf(
            WidgetRoom(id = "1", title = "With topic", topic = "Music", listeners = 7),
            WidgetRoom(id = "2", title = "Without topic", topic = null, listeners = 0),
        )
        assertEquals(rooms, decodeRooms(encodeRooms(rooms)))
    }

    @Test
    fun `decoding an unreadable blob yields no rooms rather than throwing`() {
        // This reads what a previous version of this code wrote, so the failure
        // it must survive is a schema change or a truncated write — and it runs
        // while composing a widget, where an exception is a blank home screen.
        assertEquals(emptyList<WidgetRoom>(), decodeRooms("not json at all"))
        assertEquals(emptyList<WidgetRoom>(), decodeRooms("""[{"id":"1"}]"""))
        assertEquals(emptyList<WidgetRoom>(), decodeRooms(null))
        assertEquals(emptyList<WidgetRoom>(), decodeRooms(""))
    }

    @Test
    fun `a negative listener count is clamped rather than drawn`() {
        assertEquals(0, decodeRooms("""[{"id":"1","title":"T","listeners":-5}]""")[0].listeners)
    }

    @Test
    fun `the stored shape carries only what is drawn`() {
        // A guard on the decision that the store is not the wire shape: if a
        // field is added here it should be because the widget draws it.
        val stored = encodeRooms(listOf(WidgetRoom("1", "T", "Music", 3)))
        for (wireOnlyField in listOf("host", "speakers", "stats", "maxParticipants", "streamImage")) {
            assertTrue(
                "the persisted blob should not carry `$wireOnlyField`, but was: $stored",
                !stored.contains(wireOnlyField),
            )
        }
    }
}
