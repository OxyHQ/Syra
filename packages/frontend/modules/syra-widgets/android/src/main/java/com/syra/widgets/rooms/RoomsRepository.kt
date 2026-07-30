package com.syra.widgets.rooms

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Where the widget's rooms live between renders.
 *
 * App-scoped rather than per-widget-id: every placed instance shows the same
 * public list, so one fetch serves all of them.
 *
 * A `Flow` rather than a plain read because a live Glance session does not
 * re-enter `provideGlance` when the worker calls `updateAll` — the composition
 * has to be subscribed to the store to redraw at all.
 */
private val Context.roomsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "syra_widget_live_rooms",
)

internal object RoomsRepository {
    private val KEY_ROOMS = stringPreferencesKey("rooms")
    private val KEY_FETCHED_AT = longPreferencesKey("fetchedAt")

    fun stored(context: Context): Flow<StoredRooms> =
        context.applicationContext.roomsDataStore.data.map { preferences ->
            StoredRooms(
                rooms = decodeRooms(preferences[KEY_ROOMS]),
                fetchedAtMs = preferences[KEY_FETCHED_AT] ?: 0L,
            )
        }

    suspend fun read(context: Context): StoredRooms = stored(context).first()

    /**
     * Record a batch and when it was taken.
     *
     * An EMPTY list is written, unlike the usual widget rule of never writing
     * empty. Here "nobody is live" is a real answer the widget draws, and
     * refusing to store it would leave the last non-empty batch on screen
     * claiming rooms that have since ended — the exact failure the freshness
     * policy exists to prevent. A FAILED fetch writes nothing at all, so the
     * previous batch survives and ages naturally.
     */
    suspend fun save(context: Context, rooms: List<WidgetRoom>, fetchedAtMs: Long) {
        context.applicationContext.roomsDataStore.edit { preferences ->
            preferences[KEY_ROOMS] = encodeRooms(rooms)
            preferences[KEY_FETCHED_AT] = fetchedAtMs
        }
    }
}
