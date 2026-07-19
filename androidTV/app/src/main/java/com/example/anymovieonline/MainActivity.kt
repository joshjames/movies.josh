package com.example.anymovieonline

import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.launch
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    private lateinit var api: TvApiClient
    private lateinit var adapter: TvMediaAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (TvSessionStore.getCookieHeader(this).isBlank()) {
            startActivity(Intent(this, TvLoginActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        api = TvApiClient(this)

        val queryField = findViewById<EditText>(R.id.searchField)
        val categorySpinner = findViewById<Spinner>(R.id.categorySpinner)
        val searchButton = findViewById<Button>(R.id.searchButton)
        val browseButton = findViewById<Button>(R.id.browseButton)
        val accountButton = findViewById<Button>(R.id.accountButton)
        val statusText = findViewById<TextView>(R.id.statusText)
        val grid = findViewById<RecyclerView>(R.id.mediaGrid)

        categorySpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("all", "movies", "tv")
        )

        adapter = TvMediaAdapter { item -> openItem(item) }
        grid.layoutManager = GridLayoutManager(this, 5)
        grid.adapter = adapter

        fun load() {
            val query = queryField.text.toString().trim()
            val category = String(categorySpinner.selectedItem ?: "all").lowercase()
            statusText.text = "Loading ${if (query.isBlank()) "catalog" else "search"}..."

            lifecycleScope.launch {
                api.fetchMainCatalog(query, category)
                    .onSuccess { rows ->
                        adapter.submitList(rows)
                        statusText.text = "${rows.size} item(s)"
                    }
                    .onFailure { err ->
                        statusText.text = err.message ?: "Failed to load catalog"
                    }
            }
        }

        searchButton.setOnClickListener { load() }
        browseButton.setOnClickListener { startActivity(Intent(this, TvBrowseActivity::class.java)) }
        accountButton.setOnClickListener { startActivity(Intent(this, TvAccountSettingsActivity::class.java)) }

        load()
    }

    private fun openItem(item: TvMediaItem) {
        val basePath = when {
            item.contentType == "series" && !item.localHref.isNullOrBlank() -> item.localHref.removePrefix("/")
            item.contentType == "series" && !item.imdbId.isNullOrBlank() -> "browse.html?mode=shows&query=${URLEncoder.encode(item.title, "UTF-8")}"
            item.id.startsWith("series/") -> "series.html?id=${URLEncoder.encode(item.id, "UTF-8")}"
            else -> "player.html?id=${URLEncoder.encode(item.id, "UTF-8")}"
        }

        startActivity(Intent(this, WebPlayerActivity::class.java).putExtra(WebPlayerActivity.EXTRA_PATH, basePath))
    }
}