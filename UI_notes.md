For a minimalist, TV-friendly UI that feels premium and scales cleanly down to a D-pad remote, keeping your total page footprint small is a massive advantage. Let's design these two core layout additions to fit right into that clean, structural aesthetic.

---

## 📂 1. The Library Strategy: "Mixed Layout with Intentional Rows"

For a truly minimalist, high-utility UI, **avoid forcing the user to switch between a "Global Catalog" screen and a "My Library" screen.** Constantly jumping pages feels clunky, especially on a TV.

Instead, stick to a unified main dashboard, but organize the presentation using **contextual rows** (Netflix-style) where row order and visual flags define ownership. This satisfies your minimalist aesthetic while remaining incredibly functional.

### The Layout Blueprint

* **Row 1: "Continue Watching"** (Only appears if the user has active resume states in `playback.json`).
* **Row 2: "My Watchlist / My Library"** (Dynamically pinned directly below your active playback content. This displays the items the user has explicitly chosen to add).
* **Row 3, 4, 5...: "Global Vault" / Categories** (The rest of the global server sweeps).

### Keeping it Minimalist with "State Badges"

To keep the global rows clean without looking cluttered, mix everything into the main interface browse lists but use a subtle, elegant visual marker to indicate when an item is already added to their collection.

* **The Unselected State:** A clean, flat movie poster tile with absolute zero text or clutter underneath.
* **The Focused State (D-Pad Select):** When a user highlights a card, it scales up slightly (`transform: scale(1.05)`). A minimal overlay fades into view over the bottom 20% of the card showing a small checkmark icon `✓` if it’s in their library, or a `+` icon if it isn't.

This gives the user instant context without requiring separate, competing dashboard screens.

---

## 🎬 2. Media Info Layer: The Collapsible Slide-Out Pane

Doing the media info as an overlay panel inside the player is an excellent design choice. It keeps the user immersed in the playback workspace and avoids unnecessary page-load round-trips.

Instead of a centered modal popup (which blocks the entire screen), a **right-side drawer overlay** feels far more modern and cinematic.

### The UX Blueprint

1. **Trigger:** When a user is inside `player.html`, pressing the **Up arrow** on their remote (or moving the mouse) reveals the standard video controls timeline player bar. Next to the settings icon sits an `(i)` Info button.
2. **The Panel Slide:** Clicking Info smoothly scales down the active running video window slightly and slides out a glassmorphism blurred dark panel (`backdrop-filter: blur(10px)`) from the right side, taking up exactly **30% of the screen width**.
3. **Layout Hierarchy inside the Side Frame:**
* **Top Third:** A high-res vertical layout of the movie `cover.jpg` sitting alongside the crisp title text, year, and duration.
* **Middle:** A clean, scannable block text wrapper displaying the synopsis description text.
* **Bottom Third:** A simple grid list containing Director, Key Cast, and a prominent **"Watch Trailer"** button that opens a clean inline picture-in-picture player stream.



### Minimalist Layout Implementation

By structuring the UI this way, you don't even have to interrupt or pause the underlying movie stream to look at data.

```html
<div id="mediaInfoDrawer" class="info-drawer hidden">
    <div class="drawer-content">
        <button class="close-btn" focusable>×</button>
        
        <div class="meta-header">
            <img src="" id="drawerCover" class="drawer-poster" />
            <h2 id="drawerTitle">Movie Title</h2>
            <p id="drawerMeta">2026 • 2h 15m</p>
        </div>
        
        <div class="meta-body">
            <p id="drawerSynopsis">Synopsis details go here...</p>
            <div class="credits">
                <p><strong>Director:</strong> <span id="drawerDirector"></span></p>
                <p><strong>Cast:</strong> <span id="drawerCast"></span></p>
            </div>
        </div>

        <div class="meta-actions">
            <button class="trailer-btn" focusable>▶ View Trailer</button>
        </div>
    </div>
</div>

```

```css
/* Smooth CSS Right-Side Sliding Panel Animations */
.info-drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: 30vw;
    height: 100vh;
    background: rgba(11, 15, 25, 0.85);
    backdrop-filter: blur(15px);
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 2000;
}
.info-drawer.active {
    transform: translateX(0);
}

```

This keeps the workflow unified. When a user changes tabs inside your new Profile component or toggles the info drawer inside the streaming module, they never actually leave the core single-page runtime context.

Which view element are we tackling first once your Android workspace repository setup is live?