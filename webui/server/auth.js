// GardenPi Control v2.0.0 — server/auth.js
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const logger = require('./logger');
const config = require('./config').load();

const SESSION_COOKIE = 'gp_session';

async function createFirstUser(username, password) {
  const users = db.getUsers();
  if (users.length > 0) throw new Error('Setup has already been completed.');
  if (!username || username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const passwordHash = await bcrypt.hash(password, 12);
  users.push({ id: uuidv4(), username, passwordHash, createdAt: new Date().toISOString() });
  db.saveUsers(users);
  logger.info('Initial admin account created', { username });
  return true;
}

async function verifyLogin(username, password) {
  const users = db.getUsers();
  const user = users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

// ---- User management (Configuration page > GardenPi System > Users) ----
// No roles/permissions: every signed-in user can add/remove any account and
// change anyone's password, including their own. The only hard rule is that
// the last remaining user can never be removed, so the app is never left
// with no way to sign in.

function listUsers() {
  // Never return passwordHash to the client.
  return db.getUsers()
    .map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

async function addUser(username, password) {
  if (!username || username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const users = db.getUsers();
  if (users.some(u => u.username.toLowerCase() === String(username).toLowerCase())) {
    throw new Error(`A user named "${username}" already exists.`);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id: uuidv4(), username, passwordHash, createdAt: new Date().toISOString() };
  users.push(user);
  db.saveUsers(users);
  logger.info('User added', { username });
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

async function setPassword(userId, password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const users = db.getUsers();
  const user = users.find(u => u.id === userId);
  if (!user) throw new Error('User not found.');
  user.passwordHash = await bcrypt.hash(password, 12);
  db.saveUsers(users);
  logger.info('Password changed', { username: user.username });
}

function removeUser(userId) {
  const users = db.getUsers();
  if (users.length <= 1) throw new Error('Cannot remove the last user — at least one account must always exist.');
  const index = users.findIndex(u => u.id === userId);
  if (index === -1) throw new Error('User not found.');
  const [removed] = users.splice(index, 1);
  db.saveUsers(users);

  // Also drop any active sessions for the removed account so a signed-in
  // browser can't keep acting as a user that no longer exists.
  const sessions = db.getSessions();
  let sessionsChanged = false;
  for (const token of Object.keys(sessions)) {
    if (sessions[token].userId === userId) {
      delete sessions[token];
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) db.saveSessions(sessions);

  logger.info('User removed', { username: removed.username });
  return removed.username;
}

function sessionTimeoutMs() {
  // Session timeout is a garden.json setting (webui.settings.session_timeout_minutes),
  // edited on the Configuration page - not a separate app-level Settings page.
  const sessionTimeoutMinutes = config.raw?.webui?.settings?.session_timeout_minutes;
  // 0 or negative means "never time out"
  if (!sessionTimeoutMinutes || sessionTimeoutMinutes <= 0) return null;
  return sessionTimeoutMinutes * 60 * 1000;
}

function createSession(userId, username) {
  const sessions = db.getSessions();
  const token = uuidv4() + uuidv4(); // 72 chars of randomness, good enough for a session id
  const now = Date.now();
  sessions[token] = { userId, username, createdAt: now, lastSeenAt: now };
  db.saveSessions(sessions);
  return token;
}

function touchAndValidateSession(token) {
  if (!token) return null;
  const sessions = db.getSessions();
  const session = sessions[token];
  if (!session) return null;

  const timeout = sessionTimeoutMs();
  if (timeout !== null && Date.now() - session.lastSeenAt > timeout) {
    delete sessions[token];
    db.saveSessions(sessions);
    logger.info('Session expired', { username: session.username });
    return null;
  }
  session.lastSeenAt = Date.now();
  sessions[token] = session;
  db.saveSessions(sessions);
  return session;
}

function destroySession(token) {
  const sessions = db.getSessions();
  if (sessions[token]) {
    logger.info('User logged out', { username: sessions[token].username });
    delete sessions[token];
    db.saveSessions(sessions);
  }
}

module.exports = {
  SESSION_COOKIE,
  createFirstUser,
  verifyLogin,
  createSession,
  touchAndValidateSession,
  destroySession,
  listUsers,
  addUser,
  setPassword,
  removeUser
};
