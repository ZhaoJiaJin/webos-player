const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/share/disk1';
const CACHE_FILE = path.join(__dirname, 'cache.json');
const THUMBS_DIR = path.join(__dirname, 'thumbnails');
const DELETE_LOG = path.join(__dirname, 'deleted.log');
const PRIVATE_FILE = path.join(__dirname, 'private.txt');
const MIN_DURATION_SECS = 5 * 60;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.ts', '.wmv', '.flv', '.webm']);

fs.mkdirSync(THUMBS_DIR, { recursive: true });

let videoCache = [];
let metaCache = {}; // id → probed metadata (including failed/short files)
let privateIds = new Set();
let lastScan = null;
let scanning = false;

function loadPrivate() {
  if (!fs.existsSync(PRIVATE_FILE)) return;
  const lines = fs.readFileSync(PRIVATE_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  privateIds = new Set(lines);
  console.log(`Loaded ${privateIds.size} private video IDs`);
}

function savePrivate() {
  fs.writeFileSync(PRIVATE_FILE, [...privateIds].join('\n') + (privateIds.size ? '\n' : ''));
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    videoCache = data.videos || [];
    metaCache = data.metaCache || {};
    lastScan = data.lastScan || null;
    console.log(`Cache loaded: ${videoCache.length} videos, ${Object.keys(metaCache).length} metadata entries`);
  } catch (e) {
    console.error('Cache load failed:', e.message);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastScan, videos: videoCache, metaCache }, null, 2));
}

function findVideoFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findVideoFiles(fullPath));
      } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    console.error(`Scan error in ${dir}:`, e.message);
  }
  return results;
}

async function getMetadata(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { timeout: 30000 });
    return JSON.parse(stdout);
  } catch (e) {
    console.error(`ffprobe failed for "${path.basename(filePath)}": ${e.message}`);
    return null;
  }
}

async function captureThumbnail(filePath, duration, thumbPath) {
  const seekTime = Math.max(0, Math.floor(duration * 0.1));
  try {
    await execFileAsync('ffmpeg', [
      '-ss', String(seekTime),
      '-i', filePath,
      '-vframes', '1',
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black',
      '-y', thumbPath,
    ], { timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

async function scanVideos() {
  if (scanning) {
    console.log('Scan already in progress, skipping');
    return;
  }
  scanning = true;
  console.log('Starting scan...');

  const allFiles = findVideoFiles(MEDIA_ROOT);
  console.log(`Found ${allFiles.length} video files, processing...`);

  const newCache = [];
  let probed = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    const relativePath = path.relative(MEDIA_ROOT, filePath);
    const id = crypto.createHash('md5').update(relativePath).digest('hex');
    const thumbPath = path.join(THUMBS_DIR, `${id}.jpg`);

    let cached = metaCache[id];

    if (!cached || cached.failed) {
      // New file or previously failed — probe it
      console.log(`[${++probed}] Probing: ${path.basename(filePath)}`);
      const probe = await getMetadata(filePath);

      if (!probe) {
        metaCache[id] = { failed: true };
        continue;
      }

      const format = probe.format || {};
      const duration = parseFloat(format.duration || 0);
      const tags = format.tags || {};
      const stat = fs.statSync(filePath);

      const audioTracks = (probe.streams || [])
        .filter(s => s.codec_type === 'audio')
        .map((s, i) => ({
          index: i,
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
          title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          codec: s.codec_name || '',
        }));

      cached = {
        title: tags.title || path.basename(filePath, path.extname(filePath)),
        duration: Math.floor(duration),
        durationFormatted: formatDuration(duration),
        size: parseInt(format.size || 0, 10),
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        audioTracks,
        failed: false,
      };
      metaCache[id] = cached;
    }

    if (cached.failed || cached.duration < MIN_DURATION_SECS) continue;

    if (!fs.existsSync(thumbPath)) {
      await captureThumbnail(filePath, cached.duration, thumbPath);
    }

    newCache.push({
      id,
      title: cached.title,
      filePath: relativePath,
      duration: cached.duration,
      durationFormatted: cached.durationFormatted || formatDuration(cached.duration),
      size: cached.size,
      createdAt: cached.createdAt,
      updatedAt: cached.updatedAt,
      audioTracks: cached.audioTracks || [],
    });
  }

  videoCache = newCache;
  lastScan = new Date().toISOString();
  saveCache();
  scanning = false;
  console.log(`Scan complete. ${videoCache.length} videos cached. ${probed} new files probed.`);
}

function logDeletion(video) {
  const line = `[${new Date().toISOString()}] DELETED: "${video.title}" | ${video.filePath}\n`;
  fs.appendFileSync(DELETE_LOG, line);
  console.log(line.trim());
}

// --- Routes ---

app.get('/status', (_req, res) => {
  res.json({ scanning, lastScan, totalVideos: videoCache.length });
});

app.get('/scan', async (_req, res) => {
  if (scanning) return res.json({ status: 'already scanning' });
  await scanVideos();
  res.json({ status: 'done', totalVideos: videoCache.length });
});

const VALID_ORDER_FIELDS = new Set(['title', 'createdAt', 'updatedAt']);

app.get('/videos', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit) || DEFAULT_PAGE_SIZE));
  const orderBy = VALID_ORDER_FIELDS.has(req.query.orderBy) ? req.query.orderBy : 'title';
  const orderDir = req.query.order === 'desc' ? -1 : 1;
  const q = (req.query.q || '').trim().toLowerCase();
  const showPrivate = req.query.private === 'true';

  const filtered = videoCache
    .filter(v => showPrivate ? privateIds.has(v.id) : !privateIds.has(v.id))
    .filter(v => q ? v.title.toLowerCase().includes(q) : true);

  const sorted = [...filtered].sort((a, b) => {
    const va = (a[orderBy] || '').toLowerCase();
    const vb = (b[orderBy] || '').toLowerCase();
    if (va < vb) return -orderDir;
    if (va > vb) return orderDir;
    return 0;
  });

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;

  const videos = sorted.slice(start, start + limit).map(v => ({
    id: v.id,
    title: v.title,
    duration: v.duration,
    durationFormatted: v.durationFormatted,
    thumbnailUrl: `/thumbnails/${v.id}.jpg`,
    videoUrl: `/video/${v.id}`,
    audioTracks: v.audioTracks || [],
  }));

  res.json({ page, limit, total, totalPages, orderBy, order: orderDir === 1 ? 'asc' : 'desc', videos });
});

app.get('/thumbnails/:id.jpg', (req, res) => {
  const id = req.params.id.replace(/[^a-f0-9]/gi, '');
  const thumbPath = path.join(THUMBS_DIR, `${id}.jpg`);
  if (fs.existsSync(thumbPath)) {
    res.sendFile(thumbPath);
  } else {
    res.status(404).end();
  }
});

app.get('/video/:id', (req, res) => {
  const video = videoCache.find(v => v.id === req.params.id);
  if (!video) return res.status(404).send('Not found');

  const filePath = path.join(MEDIA_ROOT, video.filePath);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ts': 'video/mp2t',
    '.wmv': 'video/x-ms-wmv', '.webm': 'video/webm', '.flv': 'video/x-flv',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/video/:id/info', async (req, res) => {
  const video = videoCache.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });

  const cached = metaCache[video.id];
  if (cached && Array.isArray(cached.audioTracks)) {
    return res.json({ audioTracks: cached.audioTracks });
  }

  const filePath = path.join(MEDIA_ROOT, video.filePath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const probe = await getMetadata(filePath);
  const audioTracks = probe
    ? (probe.streams || [])
        .filter(s => s.codec_type === 'audio')
        .map((s, i) => ({
          index: i,
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
          title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          codec: s.codec_name || '',
        }))
    : [];

  if (metaCache[video.id]) {
    metaCache[video.id].audioTracks = audioTracks;
    saveCache();
  }

  res.json({ audioTracks });
});

app.get('/video/:id/audio/:trackIndex', (req, res) => {
  const video = videoCache.find(v => v.id === req.params.id);
  if (!video) return res.status(404).send('Not found');

  const filePath = path.join(MEDIA_ROOT, video.filePath);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const trackIndex = parseInt(req.params.trackIndex, 10);
  if (isNaN(trackIndex) || trackIndex < 0) return res.status(400).send('Invalid track index');

  const startTime = parseFloat(req.query.t) || 0;

  const args = [
    '-ss', String(startTime),
    '-i', filePath,
    '-map', '0:v:0',
    '-map', `0:a:${trackIndex}`,
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  const proc = spawn('ffmpeg', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});

  req.on('close', () => proc.kill('SIGTERM'));
  proc.on('error', () => { if (!res.writableEnded) res.end(); });
});

app.delete('/video/:id', (req, res) => {
  const idx = videoCache.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found in cache' });

  const video = videoCache[idx];
  const filePath = path.join(MEDIA_ROOT, video.filePath);

  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    return res.status(500).json({ error: `Failed to delete file: ${e.message}` });
  }

  videoCache.splice(idx, 1);
  delete metaCache[video.id];
  saveCache();
  logDeletion(video);

  const thumbPath = path.join(THUMBS_DIR, `${video.id}.jpg`);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

  res.json({ ok: true });
});

app.post('/video/:id/private', (req, res) => {
  if (!videoCache.find(v => v.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  privateIds.add(req.params.id);
  savePrivate();
  res.json({ ok: true });
});

app.delete('/video/:id/private', (req, res) => {
  privateIds.delete(req.params.id);
  savePrivate();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  loadCache();
  loadPrivate();
  scanVideos();
  setInterval(scanVideos, SCAN_INTERVAL_MS);
});
