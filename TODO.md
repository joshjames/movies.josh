
WORKING LOG

** latest update*
tech debt.

- priority

fix the subscription trial expiry playback issue.  

fix/finish the android APK

fix/ finish the android TV apk

both those need finishing before enforcing paywalls.


🚀 The any.movie Pre-Launch Feature Blueprint

---------------------------------------------------------------------------------------------------------
1. The Dual-Result Search & Deduplication Layer    REVISIT. *DONE* mostly.
To search both local inventory and online torrent sources simultaneously without duplicates, your search API endpoint will act as a unified aggregator.

How it works: When a user searches "Interstellar", the API fires two asynchronous tasks simultaneously:

It queries your local Redis Index 3 (or files) to see if an asset with that title or IMDb ID already exists on your NVMe drive.
It reaches out to your online scraping APIs (YTS/EZTV).

The Deduplication Rule: The aggregator loops through the online results and cross-references their unique identifiers (IMDb IDs) against the local results. If a match is found, the online item is filtered out or marked as "status": "INSTANT_PLAY", while the others are marked as "status": "DOWNLOAD_AVAILABLE".

I want to go about this in a few ways....
  #####
1. on the browse & add page.. we will have an omni search bar at the top.  but undernearth will also have a grid of recent/new/popular  (some of these will also appear on the main page in a carosoul like new)
when they start typing in to the omni bar it has instant results you know how results come as you type...
they will appear ini the search results... but then the api will have a show more results..
when they add anyting it goes in to their library. 

(DONE)   - however it passes to the search it could be more intuitive.

have not implimented the ability to add existing in to mylibrary...   - this would blow out the my library...
but.. i guess with the new grid view this is fine.. as the mylibrary on the home page only shows the most recent added like 14 items.... then "show all" grid view..

--------------------------------------------------------------------------------------
*DONE*
2. User-Specific Library Scoping ("My Library")

To keep the main dashboard clean, you don't need a database relation table. You can track library ownership straight inside the flat user profile files you are already creating.

Update your user JSON schema (/app/storage/users/[username].json) to include tracking arrays:

JSON
{
    "username": "josh",
    "hasDonated": false,
    "myLibrary": [
        "tt0111161", 
        "tt0468569"
    ],
    "watchHistory": {
        "tt0468569": { "resumePositionSeconds": 3420, "lastWatched": "2026-06-29T01:00:00Z" }
    }
}

The Dashboard Rule: When loading the index page, the frontend reads the user's myLibrary array of IMDb IDs. It grabs those specific assets out of your global Redis cache to render a personalized "Your Collection" shelf at the very top of the UI.

this is not bad.. i just worry about performance... i also need to make the complex algorithm on what to add 
to the global library..
i will play with it... but yeah...
I want it to feel seamnless... and like they have their media and its part of the whole thing..
i will play with some ways to achieve this,

as above... - all done but can be improved - i thnk TAGGING will be a thing... and in grid view.. they can add tags to the side view like their own categories..
but also.. have categories...
 of course.. this will add so much overlay and could blow out..

--------------------------------------------------------------------------
*NEEDS MORE WORK*
3. Signup Security & Hardening Matrix

Since this will face the open web on a public domain, you need defensive code borders right at the entry point:

API Rate Limiting: Use express-rate-limit as a middleware layer mounted exclusively on /api/auth/register, /api/auth/login, and /api/auth/verify. Restrict signups to a strict maximum of 3 attempts per hour per IP address to prevent registration flooding.


-------------------

*NEEDS FINISHING*

Input Sanitization: Run validation strings to ensure usernames are strictly alphanumeric (preventing directory traversal attacks since you map usernames directly to local file paths).

Turnstile/Captcha: Drop Cloudflare’s free, non-intrusive Turnstile widget onto the registration page. It checks for bots silently without forcing your friends and family to solve annoying puzzle grids.

THIS IS PRIORITY. - api limits, bot blocking, signup blocking, cloudflare turnstile captcha..
and any other security...  will go hand in hand with....
----------------------------------------------------------------------------
*PRIORITY*
below
---------------------------------------------------------------

4.  cloudflare edge player for media player complete offloading.

Edge player, edge cdn, cloud media


---------------------------------------------------------------------

5. load balance containers in particular for GREEN BLUE and performance. on a site level

this is simple we just either configure npm with custom rules or replace it with HAproxy and load balance with sticky sessions
? actually... if we move cookie session to redis sticky sessions wont matter... i think.
all data is outside the container so we can scale up as many containers as needed..
this will also work with a docker swarm like setup so multiple "servers at a site"


---------------------------------------------------------------------------------------

6. load balance across sites at a  GEO. dns level. (using cloud flare and routing rules to closes site.)

FINAL ARCHITECTURE below.

first stage:
2 nodes. in active active..

we have server 1. current... LA 
and there is another server  snode.joshjames.site  (ill fix up dns to something better shortly but that address will auto ssh)

ssh username epic  ssh keys setup and sudo

i have another repo called anymovie.project   < this is the repo that automates all the higher infrastructure>

it will look after deployment of containers to servers all the other infra... dependencies
redis, npm, qbittorrent, (both levels... - we should be able to use qbittorrent ACROSS the wan link)




final:
so multi layers load balancing task here..
  A) GEO load balancing and dns load balancing   - direct to closesnt node server...  (depends on multi server completion)
        - using dns and workers / smart load balancing at cloudflare.

  B) also impliment DNS security and multi host fail over... i am still unsure how to achieve this....
     but basically id like it if... i can send everyone from say any.movie   > directs to a downstream dns like.. hostA.any.movie   OR anymovie.us   - anymovie.au   -   anymovie.eu - anymovie.ca - anymovie.nyc  - anymovie.la  - anymovie.uk

     even those hosts have smart dns to route if there is load or health..

    each host has a edge container   npm ?  or haproxy

    assessment note: [docs/scaling-readiness-assessment.md](docs/scaling-readiness-assessment.md)


-------------------------------------------------------------------

* LOW PRIORITY *

7. The Premium Tier & "Silly AI Ads" Engine
This is an incredibly fun feature. Embedding custom AI-generated spoof ads for free-tier users is a brilliant touch that adds huge personality while acting as a gentle nudge to support the platform.

The Seamless Playback Hack: Instead of physically modifying the underlying movie files (which would ruin the global file for premium users and consume massive Xeon CPU cycles to re-transcode), you handle ad insertion dynamically in the frontend player.

How it works: You have a dedicated directory of short, funny ad clips (/app/storage/spoof-ads/). If a user's /api/auth/me state returns hasDonated: false, your Video Player component injects an ad event handler:

The player boots up, locks the controls, and plays an ad clip from your directory first.

Once the ad finishes, it unhides the player seek bar and switches the stream source back to the main movie path.

At the halfway mark of the movie runtime, it pauses the stream, saves the position, pops up a "Commercial Break" overlay, plays ad clip #2, and then resumes the film.


----------------------------------------------------------------------

8. Advanced UI Components (Resume Watching & Categories)   DONE
Resume Watching: Every 30 seconds during media playback, the video player hits a lightweight background endpoint: /api/profile/resume. It passes the current video progress timestamp, which writes instantly to their local user profile JSON. When they return to the main catalog, your backend feeds these states to display a "Resume Watching" rail.

Sorting & Metadata Tags: Since your LibraryScanner already pulls full TMDB/IMDb metadata packets down into metadata.json, you already have access to the genres array for every film. You can use Redis to dynamically group your titles by genre tags on the fly during boot initialization.




compled below.

------------past road map-------------------



Feature Backlog & Engineering Notes    HALF DONW
Goal: Adjust the core video processing engine to output low and medium bandwidth streams instead of a redundant 1080p copy.

Target Resolutions: 720p (Medium / Mobile-HD) and 480p (Low / Cellular-Saver).

Notes: The high-quality 1080p copy is already established during ingestion via the fast-pass system. The transcoding loop should only trigger downscales.

FFmpeg Flag Recommendations:

720p: -vf "scale=-2:720" -c:v libx264 -crf 23 -preset medium

480p: -vf "scale=-2:480" -c:v libx264 -crf 24 -preset medium

2. Pre-Transcode Automation Jobs   *HALF DONE*
Goal: Establish an offline background worker or cron-based script that automatically generates the 720p and 480p streaming assets for every movie in the library.

Notes: This guarantees zero CPU-burn during heavy client playback requests. The worker must scan directories asynchronously, skipping files that already have their lower-bitrate profiles generated.

3. Dynamic On-Demand Transcode Saving (Just-In-Time)
Goal: If an un-cached resolution profile is requested by a client device, live-transcode the stream and simultaneously pipe the output straight into the movie's media directory.

Notes: This creates an adaptive caching layer. Next time any user requests that low-bandwidth stream, the player bypasses the FFmpeg pipeline entirely and reads the static file directly from the filesystem.

4. Player Bandwidth Auto-Detection
Goal: Enhance player.html to measure user connection constraints and dynamically request the optimal .web.mp4, _720p.mp4, or _480p.mp4 stream profile.

Notes: Can be implemented on the client side using the JavaScript Network Information API (navigator.connection.downlink) combined with an initial small chunk speed-test probe, or a manual resolution toggle switch in the UI.

5. Seamless Cinematic Player UI
Goal: Update player.html to be a true browser-filling, edge-to-edge media experience.   *DONE*

Notes: * Configure the HTML5 <video> element to occupy absolute layout limits (width: 100vw; height: 100vh; object-fit: contain; background: #000;).

Inject an automatic trigger handler so that opening a player link seamlessly initializes video buffer parsing and executes .play() with zero manual interaction needed.    *DONE*

6. Catalog Search & Metadata Filtering Overhaul
Goal: Redesign the search infrastructure on browse.html.     *DONE*

Notes: The current client-side search execution lacks broad matching and strict category handling. It needs robust text-matching filters, proper sorting dropdowns (By Year, By Rating, Alphabetical), and genre category grouping tabs.

7. Universal Front-End Magnet Ingestion      *DONE*
Goal: Add a clean user submission module directly to the client interface allowing manual magnet links or .torrent file inputs from secondary, non-YTS indexes.

Notes: This input module will strip metadata parameters cleanly on the client side, then forward the validated structural payload to your existing Express backend POST API route (/api/yts/add) to instruct qBittorrent.

8. Web-Based Reverse-Proxy Auth Interface   *DONE*
Goal: Bridge the secure Nginx Proxy Manager (NPM) Access List barrier with a custom, high-end web layout page (login.html).

Notes: While NPM naturally relies on native browser pop-up challenge boxes for Basic Auth, we can configure a custom interface layer that securely routes standard HTML form payloads through to validate successfully against the backend.

9. Centralized Management Engine (/admin)     *DONE*
Goal: Build a lightweight, dedicated dashboard environment located strictly at movies.joshjames.site/admin.

Notes: This secure portal will manage script states, toggle transcoding priorities, verify disk storage limits across mounted paths, and view background job performance logs without SSH terminal access.

10. Core Application Orchestration Config File (config.json)   *done*
Goal: Maintain the database-less architecture by utilizing a single global config.json file in the project root to manage application state variables.
*NA*
User Management via NPM API: Instead of writing an authentication database, the user administration module will use HTTP requests to communicate directly with your local Nginx Proxy Manager container API. Adding or deleting a user in the Joshflix admin panel will dynamically insert or destroy user credentials within the NPM backend system.

11. High-Performance Index Ingestion & Redis Cache Layer   *DONE*
Goal: Solve file discovery scalability bottlenecks as the media vault expands, avoiding sluggish disk I/O sweeps.

The Architecture Pattern:

The Problem: Reading hundreds of isolated movie folder JSON information sheets sequentially on every user page load creates severe filesystem blockages.

The Solution: Use Redis strictly as an ephemeral in-memory dictionary cache.

The Rules: The database-less philosophy remains intact. Redis holds no source-of-truth state data. If the Redis container is completely destroyed, the application self-heals by running a background sweep across the filesystem to rebuild the index.

Async Event Hooks: Whenever a new movie download concludes or the admin triggers a structural update, an async backend job updates the master index array file and updates Redis. The operations are entirely append-only and async, meaning users never experience interface freezes while index arrays assemble.

📁 Suggested Directory File Tree Adjustments
To keep things perfectly clean as we scale out these profile features, the movie asset folders should adopt this predictable structural layout:

Plaintext
/movies/
  ├── config.json                        # Global app operational configurations
  ├── master_index.json                  # Flat database fallback cache file
  └── Masters.of.the.Universe.2026/
      ├── Masters.of.the.Universe.mp4    # Pristine 1080p source copy
      ├── Masters.of.the.Universe.720p.mp4 # Pre-transcoded medium bandwidth copy
      ├── Masters.of.the.Universe.480p.mp4 # Pre-transcoded cellular bandwidth copy
      ├── movie_info.json                # Isolated metadata descriptors
      └── poster.jpg                     # Static front-end display asset
🚀 Execution Strategy Priorities
Phase 1 (User Experience Baseline): Complete Items 4, 5, and 6 first. This fixes the immediate front-end UI glitches (desktop navigation alignment, fluid full-bleed player, working keyword catalog searches).

Phase 2 (Streaming Optimization): Implement Items 1, 2, and 3. Integrate ffprobe into your library scripts to construct the 720p/480p downscale pipeline.

Phase 3 (Core Admin & Scaling): Finalize Items 8, 9, 10, and 11. Integrate the Redis auto-rebuilder and attach user configurations directly into the Nginx Proxy Manager container API interfaces.