package com.example.anymovieonline

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class TvApiClient(private val context: Context) {

    private val client = OkHttpClient.Builder().build()

    suspend fun login(baseUrl: String, usernameOrEmail: String, password: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val bodyJson = JSONObject()
                .put("email", usernameOrEmail)
                .put("password", password)

            val req = Request.Builder()
                .url("${baseUrl.removeSuffix("/")}/api/auth/login")
                .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
                .header("Content-Type", "application/json")
                .build()

            client.newCall(req).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()

                if (!response.isSuccessful || !json.optBoolean("success", false)) {
                    val msg = json.optString("error").ifBlank { "Login failed (${response.code})" }
                    throw IllegalStateException(msg)
                }

                val setCookies = response.headers.values("Set-Cookie")
                val cookiePairs = setCookies.mapNotNull { header ->
                    header.substringBefore(';').takeIf { it.contains('=') }
                }
                if (cookiePairs.isEmpty()) {
                    throw IllegalStateException("Login succeeded but no session cookie was returned.")
                }

                TvSessionStore.setBaseUrl(context, baseUrl)
                TvSessionStore.setCookieHeader(context, cookiePairs.joinToString("; "))
            }
        }
    }

    suspend fun fetchMainCatalog(query: String, category: String): Result<List<TvMediaItem>> = withContext(Dispatchers.IO) {
        runCatching {
            val baseUrl = TvSessionStore.getBaseUrl(context)
            val cookie = TvSessionStore.getCookieHeader(context)
            val isQuery = query.isNotBlank()

            val items = mutableListOf<TvMediaItem>()

            if (!isQuery) {
                val req = Request.Builder()
                    .url("${baseUrl}/api/movies?page=1&limit=120")
                    .get()
                    .header("Cookie", cookie)
                    .build()

                client.newCall(req).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                    if (!response.isSuccessful) {
                        throw IllegalStateException("Catalog request failed (${response.code})")
                    }
                    val rows = json.optJSONArray("movies") ?: JSONArray()
                    for (i in 0 until rows.length()) {
                        val row = rows.optJSONObject(i) ?: continue
                        val type = String(row.optString("contentType", "movie")).lowercase()
                        if (category == "movies" && type == "series") continue
                        if (category == "tv" && type != "series") continue
                        items.add(mapMovieRow(row, type))
                    }
                }
                return@runCatching items
            }

            val encodedQuery = java.net.URLEncoder.encode(query.trim(), "UTF-8")
            val movieReq = Request.Builder()
                .url("${baseUrl}/api/movies/search/unified?q=${encodedQuery}&localLimit=30&remoteLimit=30")
                .get()
                .header("Cookie", cookie)
                .build()

            client.newCall(movieReq).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                if (!response.isSuccessful || !json.optBoolean("success", false)) {
                    throw IllegalStateException(json.optString("error").ifBlank { "Movie search failed (${response.code})" })
                }

                val local = json.optJSONArray("localResults") ?: JSONArray()
                for (i in 0 until local.length()) {
                    val row = local.optJSONObject(i) ?: continue
                    val type = String(row.optString("contentType", "movie")).lowercase()
                    if (category == "tv") continue
                    items.add(mapMovieRow(row, type))
                }

                val remote = json.optJSONArray("remoteResults") ?: JSONArray()
                for (i in 0 until remote.length()) {
                    val row = remote.optJSONObject(i) ?: continue
                    if (category == "tv") continue
                    items.add(mapRemoteMovieRow(row))
                }
            }

            if (category != "movies") {
                val tvReq = Request.Builder()
                    .url("${baseUrl}/api/tv-shows/search?query=${encodedQuery}&limit=40")
                    .get()
                    .header("Cookie", cookie)
                    .build()

                client.newCall(tvReq).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                    if (!response.isSuccessful || !json.optBoolean("success", false)) {
                        throw IllegalStateException(json.optString("error").ifBlank { "TV search failed (${response.code})" })
                    }

                    val tvItems = json.optJSONArray("items") ?: JSONArray()
                    for (i in 0 until tvItems.length()) {
                        val row = tvItems.optJSONObject(i) ?: continue
                        items.add(mapTvRow(row))
                    }
                }
            }

            items
        }
    }

    suspend fun fetchProfile(): Result<TvProfile> = withContext(Dispatchers.IO) {
        runCatching {
            val baseUrl = TvSessionStore.getBaseUrl(context)
            val cookie = TvSessionStore.getCookieHeader(context)
            val req = Request.Builder()
                .url("${baseUrl}/api/account/profile")
                .get()
                .header("Cookie", cookie)
                .build()

            client.newCall(req).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                if (!response.isSuccessful || !json.optBoolean("success", false)) {
                    throw IllegalStateException(json.optString("error").ifBlank { "Profile request failed (${response.code})" })
                }

                val user = json.optJSONObject("user") ?: JSONObject()
                TvProfile(
                    userKey = user.optString("userKey", "unknown"),
                    email = user.optString("email", ""),
                    displayName = user.optString("displayName", user.optString("userKey", "unknown")),
                    subscriptionStatus = user.optString("subscriptionStatus", "GUEST")
                )
            }
        }
    }

    private fun mapMovieRow(row: JSONObject, type: String): TvMediaItem {
        val id = row.optString("id", row.optString("imdbId", row.optString("title", "unknown")))
        val year = row.optString("year", "")
        val rating = row.optString("imdbRating", row.optString("rating", ""))
        val subtitle = listOfNotNull(year.takeIf { it.isNotBlank() }, rating.takeIf { it.isNotBlank() }?.let { "IMDB $it" }).joinToString(" • ")
        return TvMediaItem(
            id = id,
            title = row.optString("title", "Untitled"),
            subtitle = subtitle,
            coverUrl = row.optString("cover", row.optString("poster", "")),
            contentType = if (type == "series") "series" else "movie",
            imdbId = row.optString("imdbId", "").ifBlank { null },
            localHref = row.optString("localHref", "").ifBlank { null },
            inLibrary = row.optBoolean("inLibrary", false)
        )
    }

    private fun mapRemoteMovieRow(row: JSONObject): TvMediaItem {
        val id = row.optString("imdbId", row.optString("title", "unknown"))
        val year = row.optString("year", "")
        val rating = row.optString("imdbRating", "")
        val subtitle = listOfNotNull(year.takeIf { it.isNotBlank() }, rating.takeIf { it.isNotBlank() }?.let { "IMDB $it" }).joinToString(" • ")
        return TvMediaItem(
            id = id,
            title = row.optString("title", "Untitled"),
            subtitle = subtitle,
            coverUrl = row.optString("cover", ""),
            contentType = "movie",
            imdbId = row.optString("imdbId", "").ifBlank { null },
            localHref = null,
            inLibrary = row.optBoolean("inLibrary", false)
        )
    }

    private fun mapTvRow(row: JSONObject): TvMediaItem {
        val imdb = row.optString("imdbId", "")
        val years = listOfNotNull(
            row.optString("startYear", "").takeIf { it.isNotBlank() },
            row.optString("endYear", "").takeIf { it.isNotBlank() }
        ).joinToString("-")
        val subtitle = listOfNotNull(
            years.takeIf { it.isNotBlank() },
            row.optBoolean("inLibrary", false).takeIf { it }?.let { "In Library" }
        ).joinToString(" • ")

        return TvMediaItem(
            id = imdb.ifBlank { row.optString("title", "unknown") },
            title = row.optString("title", "Untitled"),
            subtitle = subtitle,
            coverUrl = row.optString("cover", ""),
            contentType = "series",
            imdbId = imdb.ifBlank { null },
            localHref = row.optString("localHref", "").ifBlank { null },
            inLibrary = row.optBoolean("inLibrary", false)
        )
    }
}
