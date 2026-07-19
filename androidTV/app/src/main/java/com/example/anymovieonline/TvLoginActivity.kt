package com.example.anymovieonline

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class TvLoginActivity : AppCompatActivity() {

    private lateinit var api: TvApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_tv_login)

        api = TvApiClient(this)

        val serverField = findViewById<EditText>(R.id.serverField)
        val userField = findViewById<EditText>(R.id.userField)
        val passField = findViewById<EditText>(R.id.passField)
        val submitButton = findViewById<Button>(R.id.signInButton)
        val statusText = findViewById<TextView>(R.id.statusText)

        serverField.setText(TvSessionStore.getBaseUrl(this))

        submitButton.setOnClickListener {
            val baseUrl = serverField.text.toString().trim().removeSuffix("/")
            val user = userField.text.toString().trim()
            val pass = passField.text.toString()

            if (baseUrl.isBlank() || user.isBlank() || pass.isBlank()) {
                statusText.text = "Server URL, username/email, and password are required."
                return@setOnClickListener
            }

            statusText.text = "Signing in..."
            submitButton.isEnabled = false

            lifecycleScope.launch {
                val result = api.login(baseUrl, user, pass)
                submitButton.isEnabled = true
                result.onSuccess {
                    statusText.text = "Sign in successful."
                    startActivity(Intent(this@TvLoginActivity, MainActivity::class.java))
                    finish()
                }.onFailure { err ->
                    statusText.text = err.message ?: "Sign in failed."
                }
            }
        }
    }
}
