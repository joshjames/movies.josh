package com.example.anymovieonline

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class TvAccountSettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_tv_account_settings)

        val profileText = findViewById<TextView>(R.id.profileText)
        val serverText = findViewById<TextView>(R.id.serverText)
        val statusText = findViewById<TextView>(R.id.statusText)
        val openHome = findViewById<Button>(R.id.homeButton)
        val openBrowse = findViewById<Button>(R.id.browseButton)
        val logout = findViewById<Button>(R.id.logoutButton)

        val api = TvApiClient(this)

        serverText.text = "Server: ${TvSessionStore.getBaseUrl(this)}"
        statusText.text = "Loading account..."

        lifecycleScope.launch {
            api.fetchProfile()
                .onSuccess { profile ->
                    profileText.text = "User: ${profile.displayName}\nEmail: ${profile.email}\nPlan: ${profile.subscriptionStatus}"
                    statusText.text = "Account loaded"
                }
                .onFailure { err ->
                    profileText.text = "Unable to load account profile"
                    statusText.text = err.message ?: "Request failed"
                }
        }

        openHome.setOnClickListener {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }

        openBrowse.setOnClickListener {
            startActivity(Intent(this, TvBrowseActivity::class.java))
        }

        logout.setOnClickListener {
            TvSessionStore.clearSession(this)
            startActivity(Intent(this, TvLoginActivity::class.java))
            finishAffinity()
        }
    }
}
