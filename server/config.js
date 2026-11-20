const fs = require('fs');

module.exports = function loadSubtitleConfig(file, env = process.env) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return env;
    // Do not include parser errors: they may contain credential values.
    throw new Error('Could not read opensubtitles.json. Use valid JSON with quoted keys and values.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('opensubtitles.json must contain a JSON object.');
  }
  const result = { ...env };
  for (const [field, variable] of Object.entries({ apiKey: 'OPENSUBTITLES_API_KEY',
    username: 'OPENSUBTITLES_USERNAME', password: 'OPENSUBTITLES_PASSWORD',
    userAgent: 'OPENSUBTITLES_USER_AGENT' })) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new Error(`opensubtitles.json: ${field} must be a string.`);
    }
    if (config[field]) result[variable] = config[field];
  }
  return result;
};
