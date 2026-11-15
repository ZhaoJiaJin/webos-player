const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { execFile } = require('child_process');

const run = promisify(execFile);
const TEXT_CODECS = new Set(['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text']);

module.exports = function createSubtitles({ mediaRoot, cacheDir, getMetadata }) {
  const metadata = new Map();
  const pending = new Map();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');

  async function discover(video) {
    const movie = path.join(mediaRoot, video.filePath);
    const stat = await fs.promises.stat(movie);
    const signature = `${movie}:${stat.size}:${stat.mtimeMs}`;
    let embedded = metadata.get(signature);
    if (!embedded) {
      const probe = await getMetadata(movie);
      if (!probe) throw new Error('Could not read subtitle tracks');
      embedded = (probe.streams || []).filter(s => s.codec_type === 'subtitle').map(s => ({
        id: `embedded-${s.index}`, streamIndex: s.index, file: movie, signature,
        language: s.tags?.language || s.tags?.LANGUAGE || 'und',
        title: s.tags?.title || s.tags?.TITLE || '',
        codec: s.codec_name, supported: TEXT_CODECS.has(s.codec_name),
        source: 'embedded', forced: Boolean(s.disposition?.forced),
      }));
      // Keep at most one metadata entry per movie as files change.
      for (const key of metadata.keys()) if (key.startsWith(`${movie}:`)) metadata.delete(key);
      metadata.set(signature, embedded);
    }
    const directory = path.dirname(movie);
    const base = path.basename(movie, path.extname(movie));
    const external = [];
    for (const name of (await fs.promises.readdir(directory)).sort()) {
      const ext = path.extname(name).toLowerCase();
      if (!['.srt', '.vtt'].includes(ext)) continue;
      const stem = name.slice(0, -ext.length);
      if (stem.toLowerCase() !== base.toLowerCase() && !stem.toLowerCase().startsWith(`${base.toLowerCase()}.`)) continue;
      const file = path.join(directory, name);
      // Sidecars must be regular files, not links to unrelated files.
      const sidecar = await fs.promises.lstat(file);
      if (!sidecar.isFile()) continue;
      const suffix = stem.slice(base.length).replace(/^\./, '');
      external.push({ id: `external-${hash(name).slice(0, 24)}`, file,
        signature: `${file}:${sidecar.size}:${sidecar.mtimeMs}`,
        language: suffix.split('.')[0] || 'und', title: suffix || 'External subtitles',
        codec: ext.slice(1), supported: true, source: 'external', forced: /\bforced\b/i.test(suffix) });
    }
    return [...external, ...embedded];
  }

  async function convert(track) {
    const key = hash(`${track.signature}:${track.id}`);
    const output = path.join(cacheDir, `${key}.vtt`);
    if (fs.existsSync(output)) return output;
    if (!pending.has(key)) {
      const work = (async () => {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const temporary = `${output}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', track.file,
            '-map', track.source === 'embedded' ? `0:${track.streamIndex}` : '0:s:0',
            '-c:s', 'webvtt', '-f', 'webvtt', '-y', temporary], { timeout: 180000 });
          await fs.promises.rename(temporary, output);
          return output;
        } finally {
          await fs.promises.unlink(temporary).catch(() => {});
        }
      })();
      pending.set(key, work);
      work.finally(() => pending.delete(key)).catch(() => {});
    }
    return pending.get(key);
  }

  return {
    async list(video) {
      return (await discover(video)).map(({ file, signature, streamIndex, ...track }) => ({
        ...track,
        url: track.supported ? `/video/${video.id}/subtitles/${track.id}` : null,
      }));
    },
    async file(video, id) {
      const track = (await discover(video)).find(item => item.id === id);
      if (!track) return null;
      if (!track.supported) throw new Error('Image subtitles need an external SRT or VTT file');
      return convert(track);
    },
  };
};
