package com.example.anymovieonline

data class TvMediaItem(
    val id: String,
    val title: String,
    val subtitle: String,
    val coverUrl: String,
    val contentType: String,
    val imdbId: String? = null,
    val localHref: String? = null,
    val inLibrary: Boolean = false
)

data class TvProfile(
    val userKey: String,
    val email: String,
    val displayName: String,
    val subscriptionStatus: String
)
