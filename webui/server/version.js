// GardenPi Control v2.0.0
// Single source of truth for the app version: read from package.json rather
// than hardcoded here, so bumping the version in one place keeps the API
// response, the startup log line, and (indirectly, since file headers are
// updated alongside version bumps) the source file headers all in sync.
module.exports = require('../package.json').version;
