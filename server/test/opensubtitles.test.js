const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createProvider = require('../opensubtitles');
const createSubtitles = require('../subtitles');

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello\n';
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const result = (id, match = false) => ({ attributes: { language: 'en', release: `Release ${id}`,
  moviehash_match: match, download_count: 10, files: [{ file_id: id, file_name: 'provider.srt' }] } });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-online-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Movie.mkv'), Buffer.alloc(131072));
  return { dir, video: { id: 'movie', title: 'The Movie', filePath: 'Movie.mkv' } };
}

test('search ranks hash matches, caches requests, downloads multiple versions, and discovers them locally', async t => {
  const { dir, video } = fixture(t);
  const calls = [];
  const provider = createProvider({ mediaRoot: dir, env: { OPENSUBTITLES_API_KEY: 'private-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/subtitles?')) {
        assert.equal(options.headers['Api-Key'], 'private-key');
        const params = new URL(url).searchParams;
        assert.equal(params.get('moviehash'), '0000000000020000');
        assert.equal(params.get('query'), 'the movie');
        assert.equal(params.get('languages'), 'en');
        return reply({ data: [result(101), result(102, true)], total_pages: 2 });
      }
      if (url.endsWith('/download')) return reply({ link: 'https://dl.opensubtitles.com/sub.srt', remaining: 4 });
      assert.equal(options.headers['Api-Key'], undefined);
      assert.equal(options.headers.Authorization, undefined);
      return new Response(SRT);
    },
  });
  const search = await provider.search(video);
  assert.deepEqual(search.results.map(item => item.fileId), [102, 101]);
  assert.equal(search.totalPages, 2);
  await provider.search(video);
  assert.equal(calls.length, 1);
  await assert.rejects(provider.download(video, 999), /Search again/);
  const [first, duplicate] = await Promise.all([provider.download(video, 102), provider.download(video, 102)]);
  assert.equal(first.filename, duplicate.filename);
  assert.equal(first.remaining, 4);
  assert.equal(calls.length, 3);
  assert.equal(fs.readFileSync(path.join(dir, first.filename), 'utf8'), SRT);
  await provider.download(video, 102);
  assert.equal(calls.length, 3, 'Already downloaded files do not consume quota');
  const second = await provider.download(video, 101);
  assert.notEqual(first.filename, second.filename);
  const local = createSubtitles({ mediaRoot: dir, cacheDir: path.join(dir, 'cache'), getMetadata: async () => ({ streams: [] }) });
  const tracks = await local.list(video);
  assert.equal(tracks.length, 2);
  assert.equal(tracks.every(track => track.source === 'external' && track.supported), true);
});

test('provider configuration, input validation, quota failures and unsafe downloads produce useful errors', async t => {
  const { dir, video } = fixture(t);
  await assert.rejects(createProvider({ mediaRoot: dir, env: {} }).search(video), /OPENSUBTITLES_API_KEY/);
  let mode = 'search';
  let requests = 0;
  const provider = createProvider({ mediaRoot: dir, env: { OPENSUBTITLES_API_KEY: 'key' },
    fetchImpl: async url => {
      requests++;
      if (url.includes('/subtitles?')) return reply({ data: [result(101)] });
      if (mode === 'quota') return new Response('', { status: 406 });
      if (mode === 'unsafe') return reply({ link: 'http://127.0.0.1/secret' });
      if (url.endsWith('/download')) return reply({ link: 'https://dl.opensubtitles.com/sub.srt' });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/sub.srt' } });
      return new Response('<html>not subtitles</html>');
    },
  });
  for (const options of [{ language: '../../en' }, { query: '' }, { page: -1 }]) {
    await assert.rejects(provider.search(video, options), { status: 400 });
  }
  assert.equal(requests, 0);
  await provider.search(video);
  mode = 'quota';
  await assert.rejects(provider.download(video, 101), /allowance/);
  mode = 'unsafe';
  await assert.rejects(provider.download(video, 101), /invalid download address/);
  mode = 'redirect';
  await assert.rejects(provider.download(video, 101), /invalid download address/);
  mode = 'html';
  await assert.rejects(provider.download(video, 101), /UTF-8 SRT/);
  assert.deepEqual(fs.readdirSync(dir), ['Movie.mkv']);
});

test('optional login uses a server token without passing credentials to file downloads', async t => {
  const { dir, video } = fixture(t);
  let logins = 0;
  const provider = createProvider({ mediaRoot: dir,
    env: { OPENSUBTITLES_API_KEY: 'key', OPENSUBTITLES_USERNAME: 'user', OPENSUBTITLES_PASSWORD: 'secret' },
    fetchImpl: async (url, options) => {
      if (url.includes('/subtitles?')) return reply({ data: [result(101), result(102)] });
      if (url.endsWith('/login')) {
        logins++;
        assert.deepEqual(JSON.parse(options.body), { username: 'user', password: 'secret' });
        return reply({ token: 'private-token' });
      }
      if (url.endsWith('/download')) {
        assert.equal(options.headers.Authorization, 'Bearer private-token');
        return reply({ link: 'https://dl.opensubtitles.com/sub.srt' });
      }
      assert.equal(options.headers.Authorization, undefined);
      return new Response(SRT);
    },
  });
  await provider.search(video);
  await provider.download(video, 101);
  await provider.download(video, 102);
  assert.equal(logins, 1);
});

test('hash handles large sparse files and 64-bit wraparound without reading the whole movie', async t => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'large.mkv');
  const handle = await fs.promises.open(file, 'w');
  const size = 2 ** 32 + 131072;
  await handle.truncate(size);
  await handle.write(Buffer.alloc(8, 255), 0, 8, 0);
  await handle.close();
  assert.equal(await createProvider.movieHash(file), BigInt(size - 1).toString(16).padStart(16, '0'));
});
