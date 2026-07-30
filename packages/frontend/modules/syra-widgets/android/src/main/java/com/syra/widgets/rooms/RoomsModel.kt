package com.syra.widgets.rooms

import org.json.JSONArray
import org.json.JSONObject

/**
 * One live room, reduced to what the widget draws.
 *
 * The stored shape is deliberately NOT the wire shape. `GET /api/rooms` answers
 * with ~30 fields per room; four of them are drawn here. Re-encoding into this
 * smaller record means a field added to the API later cannot silently grow the
 * blob persisted on every device, and nothing the widget never renders is kept
 * on disk at all.
 *
 * `host` is deliberately absent. It arrives as a bare Oxy user id, and turning
 * one into a name would mean a second unauthenticated identity fetch per room —
 * for a line the widget has no room to draw anyway. A room is legible here as
 * its title, its topic and how many people are in it.
 */
internal data class WidgetRoom(
    val id: String,
    val title: String,
    val topic: String?,
    val listeners: Int,
)

/**
 * How many rooms are kept, whatever the API returns — and so also how many are
 * requested and how large the persisted blob can get.
 *
 * Derived from what can actually be DRAWN. The widget's declared maximum height
 * is 320dp (`syra_live_rooms_widget_max_resize_height`), which `roomRowsThatFit`
 * turns into four rows; `maxResizeHeight` is advisory, so a launcher may hand
 * over more, and this leaves headroom for that. Storing much beyond it would be
 * capacity nothing can ever display — `RoomsLayoutTest` pins the relationship in
 * both directions so this cannot quietly drift into being either too small to
 * fill the widget or far larger than it.
 */
internal const val MAX_STORED_ROOMS = 6

/**
 * The stored batch, and when it was taken.
 *
 * The timestamp is load-bearing rather than diagnostic: "live" is a claim with a
 * shelf life, and [liveRoomsView] refuses to keep making it once the batch is
 * older than the schedule that should have replaced it. A batch that has never
 * been fetched carries `fetchedAtMs = 0`.
 */
internal data class StoredRooms(
    val rooms: List<WidgetRoom>,
    val fetchedAtMs: Long,
) {
    internal companion object {
        val NEVER_FETCHED = StoredRooms(rooms = emptyList(), fetchedAtMs = 0L)
    }
}

/**
 * A trimmed string field, or null when it is absent, blank, or JSON `null`.
 *
 * The `isNull` check is the whole point, and it guards a difference NO TEST IN
 * THIS MODULE CAN SEE. The two `org.json` implementations disagree about an
 * explicit JSON null:
 *
 *  - Android's (AOSP) `optString` runs the value through `JSON.toString`, which
 *    renders `JSONObject.NULL` as the four-character string `"null"`;
 *  - Maven's `org.json` — the one `testImplementation` puts on the JVM unit-test
 *    classpath, because the mockable `android.jar` only throws — short-circuits
 *    on `NULL.equals(object)` and returns the empty-string default instead.
 *
 * Syra's room DTO sends explicit nulls (`"topic": null`, `"streamTitle": null`,
 * …), so a bare `optString` draws the word "null" on the home screen. It did.
 * Every unit test here was green while it did, and deleting this line leaves them
 * green — verified by mutation. The evidence for this guard is a screenshot of a
 * running device, not the suite; the tests below pin the INTENT so a rewrite to
 * some other formulation still has to mean the same thing.
 *
 * Do not "simplify" this to `optString(key, "")`. It is correct on both
 * implementations, which is exactly why it has to stay.
 */
private fun JSONObject.optTrimmed(key: String): String? {
    if (isNull(key)) return null
    return optString(key).trim().ifEmpty { null }
}

/**
 * Parse the live-rooms response.
 *
 * STRICT: a body that is not the documented shape throws `JSONException`, which
 * the worker treats as a contract break rather than something to retry. Rooms
 * that are individually unusable (no id, no title) are skipped rather than
 * failing the batch — one malformed row should not blank a widget.
 */
internal fun parseRoomsResponse(body: String): List<WidgetRoom> {
    val items = JSONObject(body).getJSONArray("rooms")

    return buildList(items.length()) {
        for (index in 0 until items.length()) {
            if (size >= MAX_STORED_ROOMS) break

            val item = items.optJSONObject(index) ?: continue
            val id = item.optTrimmed("_id") ?: continue
            val title = item.optTrimmed("title") ?: continue

            add(
                WidgetRoom(
                    id = id,
                    title = title,
                    topic = item.optTrimmed("topic"),
                    // `participants` is who is in the room right now. `stats` holds
                    // the peak, which would overstate a room that has emptied out.
                    listeners = item.optJSONArray("participants")?.length() ?: 0,
                ),
            )
        }
    }
}

internal fun encodeRooms(rooms: List<WidgetRoom>): String {
    val array = JSONArray()
    for (room in rooms) {
        array.put(
            JSONObject()
                .put("id", room.id)
                .put("title", room.title)
                .put("topic", room.topic)
                .put("listeners", room.listeners),
        )
    }
    return array.toString()
}

/**
 * Read a stored blob back.
 *
 * LENIENT, unlike [parseRoomsResponse]: this reads what a previous version of
 * this same code wrote, so the failure it has to survive is a schema change or a
 * truncated write, and the useful answer to both is an empty list that the next
 * fetch replaces — never an exception thrown while composing a widget.
 */
internal fun decodeRooms(stored: String?): List<WidgetRoom> {
    if (stored.isNullOrEmpty()) return emptyList()
    val array = runCatching { JSONArray(stored) }.getOrNull() ?: return emptyList()

    return buildList(array.length()) {
        for (index in 0 until array.length()) {
            if (size >= MAX_STORED_ROOMS) break

            val item = array.optJSONObject(index) ?: continue
            val id = item.optTrimmed("id") ?: continue
            val title = item.optTrimmed("title") ?: continue

            add(
                WidgetRoom(
                    id = id,
                    title = title,
                    topic = item.optTrimmed("topic"),
                    listeners = item.optInt("listeners", 0).coerceAtLeast(0),
                ),
            )
        }
    }
}
