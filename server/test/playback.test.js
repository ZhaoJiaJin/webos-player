const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { finished } = require('node:stream/promises');

test('audio endpoint converts DTS, copies video, seeks, and validates requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const movie = path.join(dir, 'movie.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '8',
    '-c:v', 'libx264', '-g', '24', '-c:a', 'dca', '-strict', '-2', movie]);
  const routes = {};
  const app = { use() {}, get(route, handler) { routes[route] = handler; }, post() {}, delete() {} };
  const context = vm.createContext({
    require: name => name === 'express' ? () => app : name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name),
    __dirname: dir, process: { env: { MEDIA_ROOT: dir } }, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('const PORT =')), context);
  vm.runInContext(`videoCache = [{ id: 'test', filePath: 'movie.mkv', duration: 8 }];
    metaCache = { test: { audioTracks: [{ codec: 'dts' }] } };`, context);
  const handler = routes['/video/:id/audio/:trackIndex'];
  async function request(trackIndex, time) {
    const res = new PassThrough();
    const chunks = [];
    res.statusCode = 200;
    res.set = () => res;
    res.status = code => { res.statusCode = code; return res; };
    res.send = body => res.end(body);
    res.on('data', chunk => { res.headersSent = true; chunks.push(chunk); });
    const done = finished(res);
    await handler({ params: { id: 'test', trackIndex }, query: { t: time } }, res);
    await done;
    return { status: res.statusCode, body: Buffer.concat(chunks) };
  }
  for (const [track, time] of [['-1', '0'], ['1', '0'], ['0', '-1'], ['0', 'NaN'], ['0', '8']]) {
    assert.equal((await request(track, time)).status, 400);
  }
  for (const time of ['0', '3']) {
    const response = await request('0', time);
    assert.equal(response.status, 200);
    const output = path.join(dir, `converted-${time}.mp4`);
    fs.writeFileSync(output, response.body);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    assert.equal(probe.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    const audio = probe.streams.find(s => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'ac3');
    assert.equal(audio.channels, 6);
    assert.ok(Math.abs(Number(probe.format.duration) - (8 - Number(time))) < 0.5);
  }
});

test('client selects conversion automatically and preserves the movie timeline', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      style: {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      listeners: {}, currentTime: 0, paused: false,
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name]; },
      children: [], appendChild(child) { this.children.push(child); }, scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, pause() {}, load() {},
      removeAttribute(name) { delete this[name]; }, play() { return Promise.resolve(); },
    });
    return elements.get(id);
  }
  const timers = new Map();
  let nextTimer = 0;
  const positions = new Map();
  const fetchRequests = [];
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element, createElement: () => element(Symbol()), addEventListener() {} },
    fetch: async (url, options) => {
      fetchRequests.push({ url, options });
      const track = { id: 'downloaded-101', language: 'en', title: 'English release', supported: true, source: 'external', url: '/downloaded.vtt' };
      return { ok: true, json: async () => url.includes('subtitle-search?')
        ? { results: [{ fileId: 101, language: 'en', release: 'Movie BluRay', fileName: 'movie.srt', hashMatch: true, downloads: 50 }], page: 1, totalPages: 2 }
        : url.includes('subtitle-download/') ? { subtitles: [track], trackId: track.id } : { subtitles: [] },
        text: async () => 'WEBVTT\n\n00:02:14.000 --> 00:02:16.000\nHello\n' };
    },
    window: { addEventListener() {} }, history: { pushState() {} },
    localStorage: { getItem: key => positions.get(key), setItem: (key, value) => positions.set(key, value) },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {}, alert: message => { throw new Error(message); },
  });
  const html = fs.readFileSync(path.join(__dirname, '../../webos-app/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/fetchPage\(1\);\s*$/, '');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../webos-app/subtitles.js'), 'utf8'), context);
  vm.runInContext(script, context);
  positions.set('pos_movie', '120');
  await vm.runInContext(`videos = [{ id: 'movie', title: 'Test', duration: 600,
    audioTracks: [{ codec: 'dts' }, { codec: 'aac' }] }]; playVideo(0);`, context);
  const video = element('video-player');
  assert.match(video.src, /\/audio\/0\?t=120$/);
  video.listeners.loadedmetadata();
  video.currentTime = 15;
  assert.equal(vm.runInContext('playbackTime()', context), 135);
  await vm.runInContext(`selectSubtitle({ id: 'english', title: 'English', supported: true, url: '/subtitles' })`, context);
  assert.equal(element('subtitle-text').textContent, 'Hello');
  vm.runInContext('subtitleDelay = 2; updateSubtitles();', context);
  assert.equal(element('subtitle-text').textContent, '');
  vm.runInContext('subtitleDelay = 0;', context);
  await vm.runInContext('selectSubtitle(null)', context);
  assert.equal(element('subtitle-text').textContent, '');
  await vm.runInContext(`selectSubtitle({ id: 'pgs', supported: false })`, context);
  assert.match(element('subtitle-status').textContent, /external SRT/);
  vm.runInContext('seekPlayback(playbackTime() + 10); seekPlayback(playbackTime() + 10);', context);
  assert.equal(vm.runInContext('playbackTime()', context), 155);
  for (const fn of [...timers.values()]) fn();
  assert.match(video.src, /\?t=155$/);
  // While a replacement stream loads, old media events must not corrupt resume time.
  video.currentTime = 99;
  assert.equal(vm.runInContext('playbackTime()', context), 155);
  video.currentTime = 0;
  video.listeners.loadedmetadata();
  video.currentTime = 5;
  vm.runInContext('selectAudioTrack(1)', context);
  assert.match(video.src, /\/audio\/1\?t=160$/);
  video.currentTime = 0;
  video.listeners.loadedmetadata();
  video.currentTime = 7;
  vm.runInContext('backToGrid()', context);
  assert.equal(positions.get('pos_movie'), '167');
  await vm.runInContext(`videos[0].audioTracks = [{ codec: 'aac' }]; playVideo(0);`, context);
  assert.match(video.src, /\/video\/movie$/);
  video.listeners.loadedmetadata();
  assert.equal(video.currentTime, 167);
  vm.runInContext('openOnlineSubtitles()', context);
  await vm.runInContext('searchOnlineSubtitles()', context);
  assert.match(fetchRequests.find(request => request.url.includes('subtitle-search?')).url, /language=en&q=Test&page=1/);
  assert.match(element('online-subtitle-results').children[0].textContent, /File match/);
  assert.equal(element('online-subtitle-next').disabled, false);
  const sourceBeforeDownload = video.src;
  await vm.runInContext('downloadOnlineSubtitle({ fileId: 101 })', context);
  assert.equal(fetchRequests.find(request => request.url.includes('subtitle-download/101')).options.method, 'POST');
  assert.equal(vm.runInContext('selectedSubtitle', context), 'downloaded-101');
  assert.equal(video.src, sourceBeforeDownload, 'Subtitle downloads must not restart the movie');
  assert.equal(positions.get('subtitle_movie'), 'downloaded-101');
  await vm.runInContext('selectSubtitle(null)', context);
  assert.equal(vm.runInContext('selectedSubtitle', context), null);
});
