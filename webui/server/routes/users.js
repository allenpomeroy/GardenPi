// GardenPi Control v2.0.0 — server/routes/users.js
// Backs the Users management block on the Configuration page (GardenPi
// System pane): list accounts, add one, set anyone's password, remove one.
//
// No roles/permissions in this app -- every signed-in user can manage every
// account, including changing another user's password or removing them.
// requireAuth (applied where this router is mounted, in server/index.js) is
// the only access check; there is no per-endpoint "is this your own account"
// restriction.
const express = require('express');
const router = express.Router();
const auth = require('../auth');

router.get('/', (req, res) => {
  res.json({ ok: true, users: auth.listUsers() });
});

router.post('/', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.addUser(username, password);
    res.json({ ok: true, user });
  } catch (err) {
    err.code = err.code || 'BAD_INPUT';
    next(err);
  }
});

router.post('/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    await auth.setPassword(req.params.id, password);
    res.json({ ok: true, message: 'Password updated.' });
  } catch (err) {
    err.code = err.code || 'BAD_INPUT';
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    // Synchronous, but kept in a try/catch since it throws on "last user"
    // and "not found" the same way the async handlers above do.
    const username = auth.removeUser(req.params.id);
    res.json({ ok: true, message: `Removed user "${username}".` });
  } catch (err) {
    err.code = err.code || 'BAD_INPUT';
    next(err);
  }
});

module.exports = router;
