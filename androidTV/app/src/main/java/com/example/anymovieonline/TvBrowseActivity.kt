package com.example.anymovieonline

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.launch
import java.net.URLEncoder

class TvBrowseActivity : AppCompatActivity() {

    private lateinit var api: TvApiClient
    private lateinit var adapter: TvMediaAdapter
    private var mode: String = "movies"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_tv_browse)

        api = TvApiClient(this)

        val queryField = findViewById<EditText>(R.id.searchField)
        val moviesTab = findViewById<Button>(R.id.moviesTab)
        val showsTab = findViewById<Button>(R.id.showsTab)
        val searchButton = findViewById<Button>(R.id.searchButton)
        val statusText = findViewById<TextView>(R.id.statusText)
        val homeButton = findViewById<Button>(R.id.homeButton)
        val accountButton = findViewById<Button>(R.id.accountButton)
        val grid = findViewById<RecyclerView>(R.id.mediaGrid)

        adapter = TvMediaAdapter { item ->
            val path = when {
                item.contentType == "series" && !item.localHref.isNullOrBlank() -> item.localHref.removePrefix("/")
                item.contentType == "series" && !item.imdbId.isNullOrBlank() -> "browse.html?mode=shows&query=${URLEncoder.encode(item.title, "UTF-8")}"
                item.id.startsWith("series/") -> "series.html?id=${URLEncoder.encode(item.id, "UTF-8")}"
                else -> "player.html?id=${URLEncoder.encode(item.id, "UTF-8")}"
            }
            startActivity(Intent(this, WebPlayerActivity::class.java).putExtra(WebPlayerActivity.EXTRA_PATH, path))
        }

        grid.layoutManager = GridLayoutManager(this, 5)
        grid.adapter = adapter

        fun renderTabs() {
            moviesTab.isEnabled = mode != "movies"
            showsTab.isEnabled = mode != "tv"
        }

        fun load() {
            val query = queryField.text.toString().trim()
            statusText.text = "Loading ${if (mode == "movies") "movies" else "tv shows"}..."

            lifecycleScope.launch {
                api.fetchMainCatalog(query, mode)
                    .onSuccess { rows ->
                        adapter.submitList(rows)
                        statusText.text = "${rows.size} ${if (mode == "movies") "movie" else "show"} result(s)"
                    }
                    .onFailure { err ->
                        statusText.text = err.message ?: "Browse failed"
                    }
            }
        }

        moviesTab.setOnClickListener {
            mode = "movies"
            renderTabs()
            load()
        }

        showsTab.setOnClickListener {
            mode = "tv"
            renderTabs()
            load()
        }

        searchButton.setOnClickListener { load() }
        homeButton.setOnClickListener { finish() }
        accountButton.setOnClickListener { startActivity(Intent(this, TvAccountSettingsActivity::class.java)) }

        renderTabs()
        load()
    }
}
