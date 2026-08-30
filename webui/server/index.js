// GardenPi Control v2.0.0 — server/index.js
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config').load();
const logger = require('./logger');
const errorHandler = require('./middleware/errorHandler');
const requireAuth = require('./middleware/requireAuth');
const scheduler = require('./scheduler');
const APP_VERSION = require('./version');

const authRoutes = require('./routes/auth');
const valveRoutes = require('./routes/valves');
const scheduleRoutes = require('./routes/schedule');
const statusRoutes = require('./routes/status');
const logsRoutes = require('./routes/logs');
const activityRoutes = require('./routes/activity');
const configRoutes = require('./routes/config');
const usersRoutes = require('./routes/users');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

// Basic request log for every API call (method, path, status, duration) -- helps
// answer "what happened, and when" without turning on verbose framework debugging.
//
// IMPORTANT: capture the path up front via req.originalUrl, not req.path, and
// don't read it lazily inside the 'finish' callback. Express only restores
// req.url/req.path to their original (un-mounted) value if the inner router
// calls next() -- our route handlers respond directly (res.json) without
// calling next(), so by the time 'finish' fires, req.path has been left in
// its sub-router-stripped state (e.g. "/setup" instead of "/api/auth/setup").
// req.originalUrl is preserved by Express specifically to avoid this.
app.use((req, res, next) => {
  const start = Date.now();
  const requestPath = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    if (requestPath.startsWith('/api')) {
      logger.info('HTTP request', {
        method: req.method, path: requestPath, status: res.statusCode, ms: Date.now() - start
      });
    }
  });
  next();
});

// Public (no auth) -- lets the login/setup screens and the app header badge
// show the running version without needing a session yet. `version` is this
// webui package's own version (package.json); `configVersion` is
// garden.json's config.version (the shared GardenPi config/system version).
app.get('/api/version', (req, res) => res.json({ ok: true, version: APP_VERSION, configVersion: config.configVersion }));

// Public (no auth) -- serves the project README.md, linked from the bottom
// of the Configuration page's Advanced section. README.md lives at the repo
// root (one level above public/), which express.static (below) never
// exposes, so it needs its own explicit route.
app.get('/README.md', (req, res) => {
  res.type('text/markdown').sendFile(path.join(__dirname, '..', 'README.md'));
});

app.use('/api/auth', authRoutes);
app.use('/api/valves', requireAuth, valveRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/status', requireAuth, statusRoutes);
// Settings page was removed - session timeout, dashboard refresh, valve
// safety limits, and concurrency are all edited on the Configuration page
// (garden.json) instead, via /api/config below.
app.use('/api/logs', requireAuth, logsRoutes);
app.use('/api/activity', requireAuth, activityRoutes);
app.use('/api/config', requireAuth, configRoutes);
// Backs the Users block on the Configuration page's GardenPi System pane --
// separate from /api/config since users live in users.json (server/db.js),
// never in garden.json (see the note at the top of server/db.js).
app.use('/api/users', requireAuth, usersRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);

const PORT = config.server.port;
const CERT_PATH = config.server.tlsCertPath;
const KEY_PATH = config.server.tlsKeyPath;

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  logger.error(`TLS certificate or key not found at ${CERT_PATH} / ${KEY_PATH}. ` +
    'Install a certificate/key at those standard paths (matching the GardenAPI\'s own ' +
    'TLS setup), run scripts/generate-cert.sh for a self-signed development certificate ' +
    'and set server.tlsCertPath/server.tlsKeyPath in garden.json to ./certs/server.crt ' +
    'and ./certs/server.key, or point them at wherever your real certificate lives.');
  process.exit(1);
}

const httpsOptions = {
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH)
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  const configNote = config._meta.loadedFromFile
    ? config._meta.configPath
    : `${config._meta.configPath} not found -- using built-in defaults`;
  logger.info(`GardenPi web UI v${APP_VERSION} listening on https://0.0.0.0:${PORT} (TLS only, GardenAPI mode: ${config.gardenApi.mock ? 'mock' : 'live'}, config: ${configNote})`);
  scheduler.start();
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});
