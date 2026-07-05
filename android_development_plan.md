# Android Development Plan (Mobile + TV)

## Executive Recommendation
- Do **not** combine Android mobile and Android TV into one UI codebase at first.
- Build them as **separate apps/modules** with a **shared core layer**.
- This gives faster delivery, lower UI complexity risk, and cleaner testing.

Reason:
- Mobile and TV interaction models are very different (touch vs D-pad/focus).
- Reusing UI directly creates fragile behavior and slower progress.
- Most reusable value is in networking, auth/session, API models, and business/domain logic.

## Effort Reality: "How much work for an APK?"

## Quick Answer
- Basic Android APK (WebView wrapper around existing PWA): **2-5 days**.
- Production-quality native-feeling mobile app: **3-8 weeks**.
- Android TV quality app (focus navigation + playback UX): **4-10 weeks**.

## Fastest Path to APK
- Use your existing web app/PWA backend and ship a thin Android shell first.
- APK can be sideloaded quickly while native features are phased in.

## Architecture Strategy

## Repo Structure (Suggested)
- `android-mobile/` (or keep under existing Android project)
- `android-tv/` (separate TV app module/project)
- Shared modules:
  - `:core-network` (Retrofit/OkHttp, auth headers, cookie/session handling)
  - `:core-model` (DTO/domain models)
  - `:core-data` (repositories, API clients)
  - `:core-player` (ExoPlayer wrapper + subtitle/audio track helpers)
  - `:core-auth` (token/session state)
  - `:core-util` (logging, feature flags, config)

## UI Layer
- Mobile UI: Jetpack Compose (phone-first, touch-first)
- TV UI: Compose for TV (focusable cards, D-pad nav, lean-back style)

## Backend Reuse
- Keep backend as source of truth (already your complex core)
- App clients should call existing endpoints and avoid duplicating logic

## Phase Plan

## Phase 0: Prep (1-2 days)
1. Confirm API contract for auth, library feed, details, playback URLs.
2. Decide session model for app:
   - Cookie-based (existing)
   - or token/JWT bridge endpoint later
3. Add a lightweight mobile API smoke document (endpoints + response samples).
4. Lock package/app IDs for mobile and TV.

Deliverables:
- API contract doc
- App IDs + environments (dev/stage/prod)

## Phase 1: Android Mobile MVP APK (2-5 days)
Goal: usable APK fast.

1. Create Android mobile app shell:
   - Splash screen
   - Single-activity host
2. Option A (fastest): WebView shell to your PWA domain.
3. Add auth/session persistence.
4. Add basic deep links (`/player.html?id=...`).
5. Build signed debug/release APK.

Deliverables:
- Installable APK
- Login + browse + playback working through existing web app

## Phase 2: Mobile Native Upgrade (2-6 weeks)
Goal: move critical paths native while keeping backend.

1. Native login screen + secure session handling.
2. Native home feed and browse screens.
3. Native player using ExoPlayer:
   - HLS/MP4 handling
   - subtitle selection
   - quality/audio selection (if available)
4. Downloads (optional phase): offline support policy.
5. Crash logging + analytics.

Deliverables:
- Native mobile app with web fallback only where needed

## Phase 3: Android TV App (4-10 weeks)
Goal: dedicated 10-foot TV UX.

1. Separate TV app/module scaffold.
2. Focus engine and D-pad navigation first.
3. Lean-back home rows, details page, hero art.
4. ExoPlayer TV playback controls + subtitle/track menu.
5. TV-specific QA on real device.

Deliverables:
- TV APK optimized for remote and big-screen UX

## Phase 4: Optional iOS (future)
1. Keep same backend contracts.
2. Choose SwiftUI + AVPlayer.
3. Reuse API/domain docs and test cases.

## Shared Code vs Split Code

## Shared (High Value)
- API clients
- Models
- Repositories
- Auth/session logic
- Playback abstractions
- Error handling and telemetry

## Split (Keep Separate)
- Screen composition and navigation
- Interaction components
- Focus management (TV only)
- Gestures/touch layouts (mobile only)

## Build/Release Steps for APK (Mobile)
1. Configure signing keystore.
2. Set `versionCode`/`versionName` policy.
3. Build:
   - debug APK for testing
   - release APK for distribution
4. Optional: Android App Bundle (`.aab`) for Play Store.

## Risks and Mitigations
- Risk: Cookie auth in WebView/native mismatch.
  - Mitigation: introduce dedicated app auth endpoint/token exchange if needed.
- Risk: TV focus bugs consume time.
  - Mitigation: separate TV UI and test early on hardware.
- Risk: playback edge cases (codec/subtitles).
  - Mitigation: standardize stream formats and test matrix per device class.

## Immediate Next Steps (Recommended)
1. Start with **Android mobile WebView shell APK** for fastest win.
2. In parallel, define shared core modules for future native screens.
3. Begin TV as separate app/module after mobile APK is stable.

## Decision Summary
- Yes, your instinct is correct: keep mobile and TV development split now.
- Share core data/network/player layers, not UI layers.
- This approach is the best speed-to-APK path with lower long-term maintenance pain.
