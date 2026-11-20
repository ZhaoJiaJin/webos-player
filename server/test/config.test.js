const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadConfig = require('../config');

test('credential file works independently of cwd and overrides environment without modifying it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opensubtitles.json');
  const env = { OPENSUBTITLES_API_KEY: 'old', PORT: '3000' };
  assert.deepEqual(loadConfig(file, env), env);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'new', username: 'user', password: 'a"b\\c', userAgent: 'MyApp v1.0' }));
  const loaded = loadConfig(file, env);
  assert.equal(loaded.OPENSUBTITLES_API_KEY, 'new');
  assert.equal(loaded.OPENSUBTITLES_USERNAME, 'user');
  assert.equal(loaded.OPENSUBTITLES_PASSWORD, 'a"b\\c');
  assert.equal(loaded.OPENSUBTITLES_USER_AGENT, 'MyApp v1.0');
  assert.equal(loaded.PORT, '3000');
  assert.equal(env.OPENSUBTITLES_API_KEY, 'old');
  fs.writeFileSync(file, '{"apiKey": "TOPSECRET", broken');
  assert.throws(() => loadConfig(file, env), error => !error.message.includes('TOPSECRET') && /valid JSON/.test(error.message));
  fs.writeFileSync(file, '{"apiKey":123}');
  assert.throws(() => loadConfig(file, env), /must be a string/);
});
