const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.opensubtitles.com/api/v1';
const MAX_BYTES = 5 * 1024 * 1024;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

async function movieHash(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 131072) return null;
    let sum = BigInt(size);
    for (const offset of [0, size - 65536]) {
      const bytes = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw fail('Movie changed while searching. Try again.', 409);
      for (let i = 0; i < bytes.length; i += 8) sum += bytes.readBigUInt64LE(i);
    }
    return BigInt.asUintN(64, sum).toString(16).padStart(16, '0');
  } finally { await handle.close(); }
}

module.exports = function createOpenSubtitles({ mediaRoot, env = process.env, fetchImpl = globalThis.fetch }) {
  const results = new Map();
  const downloads = new Map();
  const searches = new Map();
  let token = null;
  let tokenExpiry = 0;
  let loginPending = null;
  let blockedUntil = 0;
  const userAgent = env.OPENSUBTITLES_USER_AGENT || 'WebOSPlayer v1.0';

  function configured() {
    if (!env.OPENSUBTITLES_API_KEY) throw fail('Set apiKey in server/opensubtitles.json or OPENSUBTITLES_API_KEY on the server to enable online subtitles.', 503);
    if (!fetchImpl) throw fail('Online subtitles require Node.js 18 or newer on the server.', 503);
    if (Boolean(env.OPENSUBTITLES_USERNAME) !== Boolean(env.OPENSUBTITLES_PASSWORD)) {
      throw fail('Set both OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD, or neither.', 503);
    }
  }

  function allowed(url, apiOnly = false) {
    const u = new URL(url);
    const domain = u.hostname;
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
        (apiOnly ? domain !== 'api.opensubtitles.com' :
          !['opensubtitles.com', 'opensubtitles.org'].some(d => domain === d || domain.endsWith(`.${d}`)))) {
      throw fail('Subtitle provider returned an invalid download address.');
    }
    return u;
  }

  async function fetchLimited(url, options = {}, apiOnly = false) {
    const signal = AbortSignal.timeout(30000);
    try {
      for (let redirects = 0; redirects < 5; redirects++) {
        allowed(url, apiOnly);
        const response = await fetchImpl(url, { ...options, signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw fail('Subtitle provider returned an invalid redirect.');
          url = new URL(location, url).href;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            blockedUntil = Date.now() + Math.min(300, Math.max(1, Number(response.headers.get('retry-after')) || 30)) * 1000;
            throw fail('Subtitle provider rate limit reached. Wait a little before trying again.', 429);
          }
          if (response.status === 401 || response.status === 403) throw fail('OpenSubtitles rejected the credentials or API key. Check the server configuration.', 503);
          if (response.status === 406) throw fail('OpenSubtitles download allowance is exhausted. Try again after the quota resets.', 429);
          throw fail(`Subtitle provider request failed (HTTP ${response.status}).`);
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_BYTES) throw fail('Subtitle provider response is too large.');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      }
      throw fail('Too many subtitle provider redirects.');
    } catch (error) {
      if (error.status) throw error;
      throw fail('Could not connect to OpenSubtitles. Check the server internet connection and try again.');
    }
  }

  async function api(route, body, authorization) {
    configured();
    if (Date.now() < blockedUntil) throw fail('Subtitle provider rate limit reached. Wait a little before trying again.', 429);
    const headers = { 'Api-Key': env.OPENSUBTITLES_API_KEY, 'User-Agent': userAgent, Accept: 'application/json' };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    if (body) headers['Content-Type'] = 'application/json';
    const bytes = await fetchLimited(API + route, { headers, method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}) }, true);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw fail('Subtitle provider returned an invalid response.'); }
  }

  async function login() {
    if (!env.OPENSUBTITLES_USERNAME) return null;
    if (token && Date.now() < tokenExpiry) return token;
    if (!loginPending) {
      loginPending = api('/login', { username: env.OPENSUBTITLES_USERNAME, password: env.OPENSUBTITLES_PASSWORD })
        .then(data => {
          if (!data.token) throw fail('OpenSubtitles login failed.', 503);
          token = data.token;
          tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
          return token;
        }).finally(() => { loginPending = null; });
    }
    return loginPending;
  }

  async function search(video, { language = 'en', query, page = 1 } = {}) {
    configured();
    if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language)) throw fail('Choose a valid subtitle language.', 400);
    const title = query === undefined ? video.title : query;
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw fail('Enter a movie title (up to 200 characters).', 400);
    page = Number(page);
    if (!Number.isInteger(page) || page < 1 || page > 100) throw fail('Invalid results page.', 400);
    const key = JSON.stringify([video.id, language, title, page]);
    const cached = searches.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const hash = await movieHash(path.join(mediaRoot, video.filePath));
    const params = new URLSearchParams();
    const fields = { languages: language, ...(hash ? { moviehash: hash } : {}), page,
      query: title.trim().replace(/[._]/g, ' ').toLowerCase() };
    for (const key of Object.keys(fields).sort()) params.set(key, fields[key]);
    const data = await api(`/subtitles?${params}`);
    const found = [];
    for (const entry of data.data || []) {
      const attr = entry.attributes || {};
      if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(attr.language || '')) continue;
      for (const file of attr.files || []) {
        if (!Number.isSafeInteger(file.file_id) || file.file_id <= 0) continue;
        found.push({ fileId: file.file_id, language: attr.language, release: String(attr.release || file.file_name || 'Untitled release').slice(0, 300),
          fileName: String(file.file_name || '').slice(0, 300), hashMatch: Boolean(attr.moviehash_match),
          hearingImpaired: Boolean(attr.hearing_impaired), downloads: Number(attr.download_count) || 0,
          expires: Date.now() + 30 * 60 * 1000 });
      }
    }
    found.sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloads - a.downloads);
    for (const item of found) results.set(`${video.id}:${item.fileId}`, item);
    while (results.size > 2000) results.delete(results.keys().next().value);
    const value = { results: found.map(({ expires, ...item }) => item), page,
      totalPages: Math.max(1, Math.min(100, Number(data.total_pages) || 1)) };
    searches.set(key, { value, expires: Date.now() + 5 * 60 * 1000 });
    while (searches.size > 100) searches.delete(searches.keys().next().value);
    return value;
  }

  async function download(video, fileId) {
    configured();
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw fail('Invalid subtitle selection.', 400);
    const key = `${video.id}:${fileId}`;
    const result = results.get(key);
    if (!result || result.expires <= Date.now()) throw fail('Search again before downloading this subtitle.', 400);
    if (!downloads.has(key)) {
      const work = (async () => {
        const movie = path.join(mediaRoot, video.filePath);
        const base = path.basename(movie, path.extname(movie));
        const filename = `${base}.${result.language}.opensubtitles-${fileId}.srt`;
        const target = path.join(path.dirname(movie), filename);
        try {
          const existing = await fs.promises.lstat(target);
          if (!existing.isFile()) throw fail('A non-file entry already uses this subtitle name.', 409);
          return { filename, alreadyDownloaded: true };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const data = await api('/download', { file_id: fileId, sub_format: 'srt' }, await login());
        if (!data.link) throw fail('OpenSubtitles did not provide a subtitle download.');
        const bytes = await fetchLimited(data.link, { headers: { 'User-Agent': userAgent } });
        const text = bytes.toString('utf8');
        if (text.includes('\0') || text.includes('\uFFFD') || !/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text) || /<!doctype|<html[\s>]/i.test(text)) {
          throw fail('Provider did not return UTF-8 SRT subtitles. Choose another result.');
        }
        const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          await fs.promises.writeFile(temporary, text, { flag: 'wx' });
          // Publish without overwriting an existing subtitle (including on USB filesystems).
          try { await fs.promises.copyFile(temporary, target, fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        } catch (error) {
          if (['EACCES', 'EROFS', 'EPERM'].includes(error.code)) throw fail('The server needs write permission to the movie folder to save subtitles.', 500);
          throw error;
        } finally { await fs.promises.unlink(temporary).catch(() => {}); }
        return { filename, remaining: data.remaining };
      })();
      downloads.set(key, work);
      work.finally(() => downloads.delete(key)).catch(() => {});
    }
    return downloads.get(key);
  }

  return { search, download };
};

module.exports.movieHash = movieHash;
