// GardenPi Control v2.0.0 — server/routes/auth.js
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const db = require('../db');
const logger = require('../logger');

// Is setup (first admin account creation) still needed?
router.get('/setup-status', (req, res) => {
  res.json({ ok: true, setupComplete: db.hasAnyUser() });
});

router.post('/setup', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    await auth.createFirstUser(username, password);
    const token = auth.createSession(username, username);
    setSessionCookie(res, token);
    res.json({ ok: true, username });
  } catch (err) {
    err.code = err.code || 'BAD_INPUT';
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.verifyLogin(username, password);
    if (!user) {
      logger.warn('Failed login attempt', { username });
      return res.json({ ok: false, message: 'Incorrect username or password.' });
    }
    const token = auth.createSession(user.id, user.username);
    setSessionCookie(res, token);
    logger.info('User logged in', { username: user.username });
    res.json({ ok: true, username: user.username });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const token = req.cookies[auth.SESSION_COOKIE];
  auth.destroySession(token);
  res.clearCookie(auth.SESSION_COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies[auth.SESSION_COOKIE];
  const session = auth.touchAndValidateSession(token);
  if (!session) return res.json({ ok: true, authenticated: false });
  res.json({ ok: true, authenticated: true, username: session.username });
});

function setSessionCookie(res, token) {
  res.cookie(auth.SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,       // TLS-only deployment
    sameSite: 'strict',
    path: '/'
  });
}

module.exports = router;
