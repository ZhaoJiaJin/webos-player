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
| Double-scroll wheel | Next / previous page |
| Double-click "Videos" | Toggle private mode |

## Server API

| Endpoint | Description |
|---|---|
| `GET /videos` | Paginated video list. Params: `page`, `limit`, `orderBy`, `order`, `q`, `private` |
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
