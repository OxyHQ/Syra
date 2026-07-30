package com.syra.widgets.rooms

import android.content.Context
import com.syra.widgets.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * The widget's only network call.
 *
 * ANONYMOUS — and read this before adding a token, because it is FORCED, not a
 * style preference.
 *
 * A widget runs outside the app process with no JS runtime, so reading anything
 * authenticated needs the native device-first session (`so.oxy.session`) that
 * `@oxyhq/services` 24.0.2 ships. This app is on services 22 / core 12, where
 * that native session does not exist at all — so there is no supported way for
 * this file to hold a credential, and adding one would mean dragging the app
 * through an SDK major migration first.
 *
 * If that migration ever happens, an authenticated widget is NOT just this file
 * plus a bearer. It also owes the account-stamping contract: the store has to be
 * stamped with the account it belongs to and report EMPTY when read with a
 * different one, or a previous account's rooms surface on the home screen after
 * a switch. Do not add the token without that.
 *
 * What makes the widget possible meanwhile: `GET /api/rooms` is mounted on the
 * backend's public router behind optional auth (`packages/backend/server.ts`),
 * so it answers an unauthenticated request with the live batch — verified
 * against production. Nothing here carries a session, a token or an account, so
 * nothing account-scoped can be cached on a lock-screen-adjacent surface, and
 * switching accounts cannot strand a previous account's data on the home screen
 * because none of it was ever account-scoped.
 *
 * The rooms it lists are public by construction: since this commit, `/rooms`
 * withholds rooms owned by a house the caller may not see into, and an anonymous
 * caller is a member of nothing.
 *
 * `HttpURLConnection` rather than a client library: this runs in the launcher's
 * process for one request every few minutes, and the module has no reason to pull
 * an HTTP stack into the app for it.
 */
internal object RoomsApi {
    private const val REQUESTED_ROOMS = MAX_STORED_ROOMS
    private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
    private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15).toInt()

    suspend fun fetch(context: Context): List<WidgetRoom> = withContext(Dispatchers.IO) {
        // The resource is a bare ORIGIN; the `/api` prefix belongs here, beside
        // the path it prefixes, so the origin stays validatable as an origin.
        val base = context.getString(R.string.syra_widget_api_base_url).trimEnd('/')
        val url = URL("$base/api/rooms?status=live&limit=$REQUESTED_ROOMS")

        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }

        try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw IOException("GET /rooms responded $status")
            }
            parseRoomsResponse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }
}
