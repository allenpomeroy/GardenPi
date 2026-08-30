// GardenPi Control v2.0.0 — server/middleware/requireAuth.js
const auth = require('../auth');

module.exports = function requireAuth(req, res, next) {
  const token = req.cookies[auth.SESSION_COOKIE];
  const session = auth.touchAndValidateSession(token);
  if (!session) {
    return res.status(401).json({ ok: false, message: 'Your session has ended. Please sign in again.' });
  }
  req.session = session;
  next();
};
