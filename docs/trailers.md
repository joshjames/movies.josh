add trailer watch button / popup / embedded video on the info pane / info panel

----
The Movie Database (TMDb) API already indexes official YouTube trailer keys for practically every movie and TV show in existence. Instead of scraping YouTube or self-hosting gigabytes of extra video files, you make a single API request, get the exact YouTube key, and render the standard YouTube embed player.

we have themoviedb api key in .env setup
---

### Step 1: The API Call (TMDb)

To fetch trailers for a given movie, query TMDb's `/videos` endpoint:

```http
GET https://api.themoviedb.org/3/movie/{movie_id}/videos?api_key=YOUR_TMDB_API_KEY

```

The payload returns an array of video objects. You simply filter for `site === "YouTube"`, `type === "Trailer"`, and prioritize `official === true`:

```json
{
  "id": 550,
  "results": [
    {
      "name": "Official Trailer",
      "key": "dQw4w9WgXcQ",
      "site": "YouTube",
      "type": "Trailer",
      "official": true
    }
  ]
}

```

---

### Step 2: The Frontend Trailer Component

Once you have the `key` (e.g., `dQw4w9WgXcQ`), render the YouTube `iframe` dynamically inside your web interface or app modal:

```html
<div class="trailer-container">
  <iframe 
    src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1" 
    title="Movie Trailer" 
    frameborder="0" 
    allow="autoplay; encrypted-media" 
    allowfullscreen>
  </iframe>
</div>

```

*Using `youtube-nocookie.com` keeps the player lightweight, privacy-friendly, and clean of third-party tracking.*

---

### Why Option 3 Wins Over the Others

* **VS. Option 1 & 2 (Scraping/Manual Review):** Custom YouTube search queries require fine-tuning to filter out fan-made concept trailers, reaction videos, and low-res re-uploads. TMDb's community curates the exact official trailer key for you.
* **VS. Option 4 (Self-Hosting Trailers):** Downloading `.mp4` trailers to your object storage wastes drive space and adds unneeded transfer traffic. YouTube handles encoding, multi-resolution adaptive streaming (1080p down to 360p depending on client connection), and bandwidth completely for free.
* **VS. Option 5 (FFmpeg Auto-Clips):** Running FFmpeg render jobs across your entire library to extract 30-second low-bitrate clips is CPU-heavy and gives you arbitrary scene slices instead of a professionally edited, high-hype official trailer.

---

### Fallback Strategy (Option 3 + Option 1)

For 99% of media, TMDb will return a valid key. For obscure or rare titles where TMDb returns an empty `results` array, programmatically fall back to a direct YouTube Search URL button:

```javascript
const fallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(movieTitle + ' ' + releaseYear + ' official trailer')}`;

```

This gives you a rock-solid, zero-maintenance trailer pipeline integrated natively into your app in under 20 lines of code.