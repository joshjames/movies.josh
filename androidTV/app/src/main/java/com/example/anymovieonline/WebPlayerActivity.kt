package com.example.anymovieonline

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class WebPlayerActivity : AppCompatActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_web_player)

        val path = intent.getStringExtra(EXTRA_PATH).orEmpty()
        val baseUrl = TvSessionStore.getBaseUrl(this)
        val cookie = TvSessionStore.getCookieHeader(this)

        val webView = findViewById<WebView>(R.id.playerWebView)
        webView.webViewClient = WebViewClient()
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        if (cookie.isNotBlank()) {
            cm.setCookie(baseUrl, cookie)
            cm.flush()
        }

        val targetUrl = if (path.startsWith("http://") || path.startsWith("https://")) {
            path
        } else {
            "${baseUrl.removeSuffix("/")}/${path.removePrefix("/")}"
        }

        webView.loadUrl(targetUrl)
    }

    companion object {
        const val EXTRA_PATH = "path"
    }
}
