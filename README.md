# webOS Video Player

A self-hosted video player for LG webOS TVs that streams from a local file server. Browse, search, and play video files via a TV-optimized grid UI.

## Architecture

```
LG TV (webOS app)
    ↕ HTTP
Node.js server  →  local video files (/share/disk1)
```

The server scans your video library, extracts metadata with `ffprobe`, generates thumbnails with `ffmpeg`, and exposes a REST API. The webOS app is a plain HTML/JS app deployed directly to the TV.

## Requirements

- LG webOS TV with Developer Mode enabled
- Node.js on the file server
- `ffmpeg` and `ffprobe` on the file server
- [`@webosose/ares-cli`](https://www.npmjs.com/package/@webosose/ares-cli) on your dev machine

## Server Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure media root

The server reads from `/share/disk1` by default. Override with an environment variable:

```bash
MEDIA_ROOT=/path/to/videos node index.js
```

### 3. Start the server

```bash
node index.js
```

The server runs on port `3000` and is accessible at `http://0.0.0.0:3000`.

On startup the server:
1. Loads the cache from `cache.json`
2. Loads private video IDs from `private.txt`
3. Starts a background scan
4. Re-scans every hour automatically

## webOS App Setup

### 1. Enable Developer Mode on the TV

Settings → General → TV Management → Developer Mode. Note the TV's IP address shown in the Developer Mode app.

### 2. Configure the server address

Edit `webos-app/index.html` and set the server IP:

```js
const SERVER_URL = 'http://192.168.1.2:3000';
```

### 3. Package and deploy

```bash
ares-package webos-app/
ares-setup-device   # add your TV
ares-install com.example.sambavideoapp_1.0.0_all.ipk
ares-launch com.example.sambavideoapp
```

## Features

### Video library
- Scans all video files (`.mp4`, `.mkv`, `.avi`, `.mov`, `.m4v`, `.ts`, `.wmv`, `.flv`, `.webm`)
- Filters out videos shorter than **5 minutes**
- Extracts title, duration, file size, and timestamps via `ffprobe`
- Generates 320×180 thumbnails via `ffmpeg` at 10% into each video
- Metadata and thumbnails are cached — subsequent scans only probe new files
- Previously failed probes are retried on each rescan

### Browsing
- 4×3 grid (12 videos per page)
- Sort by **Title**, **Date Created**, or **Date Modified** (default: newest first)
- Keyword search by title
- Scroll wheel (double-scroll) to navigate pages
- Rescan button triggers an immediate re-scan of the library

### Playback
- Streams directly over HTTP with range request support (seeking works)
- **Resume**: play position saved every 5 seconds; resumes on next open
- Progress bar shown on thumbnails for partially-watched videos
- Back button returns to the grid (no exit dialog)
- Left/Right arrows seek ±10 seconds
- OK/Enter toggles play/pause
- DTS / DTS-HD and Dolby TrueHD audio automatically converts to AC3 5.1 at 640 kbps on the server; video is copied without re-encoding
- Other audio codecs continue to play directly; switching tracks remuxes the selected track and converts it if necessary
- Converted streams restart on seeking, with resume positions and the progress bar using the original movie timeline. Video may briefly wait for the next keyframe after a seek.
- Conversion requires FFmpeg with the AC3 encoder. On a Raspberry Pi 3B, benchmark your file first; conversion speed must exceed real time. Only audio is converted, but Blu-ray video bitrate can still exceed available disk/network throughput

### Subtitles
- External UTF-8 `.srt` and `.vtt` files are discovered beside the movie. Use the movie basename, optionally followed by language/labels: `Movie.mkv`, `Movie.en.srt`, `Movie.zh.forced.srt`.
- Embedded text subtitles (SubRip, WebVTT, ASS/SSA, and MP4 timed text) are discovered on demand. The selected track is extracted to WebVTT and cached in `server/subtitle-cache/`; initial extraction of a large movie can take time.
- Press **Down** during playback or click **CC** to open the subtitle menu. Up/Down navigates, OK selects, and Back closes the menu. Choose **Off** to disable subtitles.
- The final menu row adjusts delay with Left/Right or the −/+ buttons in 0.5-second steps (±30 seconds). Positive delay makes subtitles appear later. Track choice and delay are remembered per movie on the TV.
- Subtitles remain synchronized with the original movie timeline during seeking, resume, and audio conversion. Rendering uses plain text; advanced ASS styling and cue positioning are not preserved.
- Image subtitles such as Blu-ray PGS and DVD VobSub are listed as unavailable. Add an external SRT/VTT alternative; video is never re-encoded to burn subtitles in.
- Subtitle discovery/extraction failures do not stop video playback. Cache files are generated locally and ignored by Git.

### Find and download subtitles online

During playback, click **Find subtitles**, or press **Down** → **Find subtitles online…** in the CC menu. Choose a language, edit the title if needed, and press **Search**. Results include the release name, file match status, hearing-impaired flag, and download count. Use Previous/Next for more results. Select a result to download and activate it without restarting playback. All downloaded versions remain available in the CC menu, alongside local and embedded subtitles.

The Raspberry Pi performs searches and downloads. The TV never receives provider credentials. Search uses the movie title and OpenSubtitles hash (only the first and last 64 KiB are read), prioritizes file matches, and caches searches for five minutes. Downloads happen only when you select a result. Each version is saved beside its movie as `Movie.en.opensubtitles-12345.srt`; choosing an already downloaded version does not spend another download. The server needs write permission to the movie folder.

**Server setup:** requires Node.js 18+ for online subtitle requests. Create an API key in your [OpenSubtitles API consumer profile](https://www.opensubtitles.com/en/consumers), then set the environment before starting the server:

```bash
cd server
export OPENSUBTITLES_API_KEY='your-api-key'
# Optional: use your account download allowance instead of the anonymous allowance.
export OPENSUBTITLES_USERNAME='your-username'
export OPENSUBTITLES_PASSWORD='your-password'
npm start
```

Leave both username and password unset to use the anonymous allowance. If you run the server through systemd or another process manager, set these environment variables there and restart it. `OPENSUBTITLES_USER_AGENT` optionally overrides the default `WebOSPlayer v1.0`; use the application identity registered for your API key. Do not put credentials in the TV app or commit them to Git. Quotas depend on the provider/account; the client displays authentication, quota, network, and write-permission errors. Existing local subtitles and video playback work without an API key. Files must be UTF-8 SRT; unsupported provider responses are rejected.

Provider references: [API setup](https://opensubtitles.tawk.help/article/getting-started), [search/download integration](https://blog.opensubtitles.com/opensubtitles/how-to-build-a-movie-subtitle-finder-cli-with-python-and-the-opensubtitles-api), [movie hash specification](https://opensubtitles.github.io/oshash/).

### Private videos
- Mark any video as private with the 🔒 button (top-left of card)
- Private IDs stored in `server/private.txt`, one per line
- Default view shows only non-private videos
- **Double-click "Videos"** in the header to switch to the private-only view
- Double-click again to return to normal view

### Delete
- 🗑 button (top-right of card) deletes the file from disk
- Confirmation dialog before deletion
- Deletions logged to `server/deleted.log` with timestamp and path

## Remote Control

| Action | Result |
|---|---|
| D-pad / Magic Remote pointer | Navigate cards |
| OK / Enter | Play selected video |
| Back | Return to grid from player |
| Left / Right (in player) | Seek ±10 seconds |
| OK / Enter (in player) | Play / Pause |
| Down (in player) | Open subtitle menu |
| Double-scroll wheel | Next / previous page |
| Double-click "Videos" | Toggle private mode |

## Server API

| Endpoint | Description |
|---|---|
| `GET /videos` | Paginated video list. Params: `page`, `limit`, `orderBy`, `order`, `q`, `private` |
| `GET /video/:id/subtitle-search` | Search OpenSubtitles. Params: `language`, `q`, `page`. Requires server API key. |
| `POST /video/:id/subtitle-download/:fileId` | Download a file from recent search results, returning the refreshed subtitle list and selected track ID. |
| `GET /video/:id/subtitles` | List external and embedded subtitles with supported formats and language labels |
| `GET /video/:id/subtitles/:trackId` | Serve a cached WebVTT conversion of the selected text track |
| `GET /video/:id/info` | Audio track metadata |
| `GET /video/:id/audio/:trackIndex?t=seconds` | Stream selected audio track in fragmented MP4; converts DTS/TrueHD to AC3 and copies video. Track index is zero-based among audio tracks. |
| `GET /video/:id` | Stream a video (supports HTTP range requests) |
| `GET /thumbnails/:id.jpg` | Serve a thumbnail |
| `GET /scan` | Trigger a synchronous rescan; returns when complete |
| `GET /status` | Scan status and total video count |
| `POST /video/:id/private` | Mark video as private |
| `DELETE /video/:id/private` | Remove private mark |
| `DELETE /video/:id` | Delete video file from disk |

## Server Files

| File | Purpose |
|---|---|
| `cache.json` | Cached video list and all probed metadata |
| `thumbnails/` | Generated thumbnail images |
| `private.txt` | Private video IDs (one per line) |
| `deleted.log` | Deletion audit log |

## Tests

Run `npm test` from `server/`. The playback tests require `ffmpeg` and `ffprobe`, including the `libx264`, `dca`, and `ac3` encoders for the generated sample. They check DTS-to-AC3 streaming, seek timestamps, invalid requests, client resume/track switching, subtitle discovery/extraction/cache invalidation, subtitle timing, and online search/download behavior (provider requests are mocked; no API quota is used by tests).
