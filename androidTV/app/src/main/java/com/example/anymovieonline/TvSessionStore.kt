package com.example.anymovieonline

import android.content.Context

object TvSessionStore {
    private const val PREF_NAME = "anymovie_tv_session"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_COOKIE_HEADER = "cookie_header"

    fun getBaseUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_BASE_URL, BuildConfig.DEFAULT_API_BASE_URL)
            ?.trim()
            ?.removeSuffix("/")
            ?: BuildConfig.DEFAULT_API_BASE_URL
    }

    fun setBaseUrl(context: Context, value: String) {
        val clean = value.trim().removeSuffix("/")
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_BASE_URL, clean)
            .apply()
    }

    fun getCookieHeader(context: Context): String {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_COOKIE_HEADER, "") ?: ""
    }

    fun setCookieHeader(context: Context, cookieHeader: String) {
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_COOKIE_HEADER, cookieHeader.trim())
            .apply()
    }

    fun clearSession(context: Context) {
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_COOKIE_HEADER)
            .apply()
    }
}
