android studio setup

Since your current repository is a Node.js web app and backend, you want to keep it clean. Do **not** mix your Android Java/Kotlin source trees directly into your root web directories. It creates dependency chaos, ruins your `.gitignore` tracking, and messes with automated deployment containers (like your Docker pre-push hook).

The cleanest, industry-standard approach for a solo developer is the **Subdirectory Strategy** within your existing repository.

---

## 📁 The Subdirectory Monorepo Layout

You should keep your entire ecosystem in one repository so your backend API changes and frontends stay in sync, but partition the Android project completely into its own folder.

Your repository structure should look like this:

```text
movie-streamer/ (Root Git Repo)
├── .git/
├── .gitignore (The root file we fixed)
├── package.json (Backend/Web dependencies)
├── server.js
├── src/ (Node.js backend logic)
├── public/ (Web Frontend assets)
│
└── android-tv/ (◄ CREATE THIS SUBDIRECTORY)
    ├── build.gradle.kts
    ├── settings.gradle.kts
    └── app/
        ├── src/ (Native Android Kotlin code)
        └── build.gradle.kts

```

---

## 🛠️ Step-by-Step Implementation

### Step 1: Create the directory locally

In your Linux terminal, navigate to your project root and create a clean directory for the app:

```bash
cd ~/movie-streamer
mkdir android-tv

```

### Step 2: Initialize in Android Studio

1. Open **Android Studio**.
2. Click **New Project**.
3. Select **Android TV** from the templates pane on the left, then choose **Empty Activity (with Compose)**.
4. For the **Save location**, browse directly to your newly created folder: `~/movie-streamer/android-tv`.
5. Ensure the language is set to **Kotlin** and build configuration is **Kotlin DSL (`build.gradle.kts`)**.
6. Click **Finish**.

### Step 3: Use a Dedicated Git Feature Branch

Before committing any of these newly generated files, switch to a safe workspace branch so you don't clutter your working `v2` line while fighting configuration setups:

```bash
# Switch to a fresh native layout branch
git checkout -b feature/android-tv-setup

```

---

## 🛡️ Crucial: Update Your Root `.gitignore` Immediately

Android Studio generates a massive amount of local environment bloat (`.gradle`, build caches, local properties, machine-specific SDK paths). Android Studio will create a `.gitignore` *inside* the `android-tv/` folder automatically, but you should protect your root directory just in case.

Open your **root** `.gitignore` file (`~/movie-streamer/.gitignore`) and append these lines at the bottom:

```text
# Android Studio / Gradle build outputs
android-tv/.gradle/
android-tv/build/
android-tv/app/build/
android-tv/local.properties
android-tv/.idea/
android-tv/*/.link/

```

This setup ensures that when you run `git status` in your root directory, it treats the entire `android-tv` app as a single, isolated module. You can modify your Node.js backend routes and your Android layouts simultaneously, commit them under a single unified feature branch, and keep your production pipeline perfectly decoupled.