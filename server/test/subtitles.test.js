const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const createSubtitles = require('../subtitles');

test('discovers sidecars and embedded text, caches extraction, and rejects image tracks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-subtitles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srt = '1\n00:00:00,500 --> 00:00:02,000\nHello world\n';
  fs.writeFileSync(path.join(dir, 'Movie.en.srt'), srt);
  fs.writeFileSync(path.join(dir, 'Other.srt'), srt);
  fs.writeFileSync(path.join(dir, 'Movie.fr.vtt'), 'WEBVTT\n\n00:00.500 --> 00:02.000\nBonjour\n');
  fs.symlinkSync(path.join(dir, 'Other.srt'), path.join(dir, 'Movie.link.srt'));
  const movie = path.join(dir, 'Movie.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24',
    '-i', path.join(dir, 'Movie.en.srt'), '-t', '3', '-map', '0:v', '-map', '1:s',
    '-c:v', 'libx264', '-c:s', 'srt', movie]);
  let probes = 0;
  const service = createSubtitles({ mediaRoot: dir, cacheDir: path.join(dir, 'cache'),
    getMetadata: async file => {
      probes++;
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
      probe.streams.push({ index: 9, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' });
      return probe;
    },
  });
  const video = { id: 'movie', filePath: 'Movie.mkv' };
  const tracks = await service.list(video);
  assert.equal(tracks.length, 4);
  assert.equal(tracks.some(track => 'file' in track), false);
  assert.ok(tracks.some(track => track.language === 'en' && track.source === 'external'));
  const embedded = tracks.find(track => track.source === 'embedded' && track.supported);
  const external = tracks.find(track => track.language === 'en');
  const files = await Promise.all([service.file(video, embedded.id), service.file(video, embedded.id)]);
  assert.equal(files[0], files[1]);
  const text = fs.readFileSync(files[0], 'utf8');
  assert.match(text, /^WEBVTT/);
  assert.match(text, /Hello world/);
  assert.match(fs.readFileSync(await service.file(video, external.id), 'utf8'), /Hello world/);
  assert.equal(probes, 1);
  assert.equal(await service.file(video, '../not-a-track'), null);
  await assert.rejects(service.file(video, 'embedded-9'), /Image subtitles/);
  const before = await service.file(video, external.id);
  fs.writeFileSync(path.join(dir, 'Movie.en.srt'), srt.replace('Hello world', 'Updated subtitles'));
  const after = await service.file(video, external.id);
  assert.notEqual(before, after);
  assert.match(fs.readFileSync(after, 'utf8'), /Updated subtitles/);
});

test('WebVTT parsing handles cue IDs, settings, multiline text, overlapping cues and delays safely', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../webos-app/subtitles.js'), 'utf8'), context);
  context.source = '\uFEFFWEBVTT\r\n\r\nNOTE ignored\r\ncomment\r\n\r\ncue-id\r\n00:01.000 --> 00:03.000 align:center\r\n<i>Hello</i> &amp; &#x4e2d;\r\nSecond line\r\n\r\n00:02.000 --> 00:04.000\r\nOverlap\r\n\r\ninvalid --> time\r\nIgnored\r\n';
  vm.runInContext('var cues = SubtitleTools.parse(source)', context);
  assert.equal(vm.runInContext('cues.length', context), 2);
  assert.equal(vm.runInContext('SubtitleTools.textAt(cues, 2.5, 0)', context), 'Hello & 中\nSecond line\nOverlap');
  assert.equal(vm.runInContext('SubtitleTools.textAt(cues, 1.5, 1)', context), '');
  assert.equal(vm.runInContext('SubtitleTools.textAt(cues, 4.5, 1)', context), 'Overlap');
  assert.equal(vm.runInContext('SubtitleTools.textAt(cues, 4, 0)', context), '');
  assert.throws(() => vm.runInContext("SubtitleTools.parse('not subtitles')", context), /Invalid WebVTT/);
});
