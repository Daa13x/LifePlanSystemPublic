// Minimal multi-user auth for the Closed Beta hosted deployment.
//
// Desktop stays exactly as it always was: LIFE_PLANNER_MULTI_USER is unset,
// every request is silently attributed to LOCAL_USER_ID, and nothing here is
// ever reachable or visible. A hosted deployment (a separate process, a
// separate database) sets LIFE_PLANNER_MULTI_USER=1, which requires every
// request to carry a real bearer token issued by /api/auth/register or
// /api/auth/login, and makes chat/planner data ownership-scoped per user.
//
// Passwords are hashed with scrypt (Node's built-in, no new dependency) and
// a per-user random salt; tokens are opaque random values, never JWTs, so
// there is nothing to forge -- only a real row in auth_tokens grants access.

import crypto from 'node:crypto';

export const LOCAL_USER_ID = 1;
export const MULTI_USER = process.env.LIFE_PLANNER_MULTI_USER === '1';

const SCRYPT_KEYLEN = 64;

export function createUsersTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  `);

  // The desktop app's own data (created long before user_id existed) must
  // keep working with zero UX change -- seed a fixed local user every
  // database starts with, so existing/new chat_sessions and planner_tasks
  // rows can default their user_id to it without ever prompting anyone.
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(LOCAL_USER_ID);
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(crypto.randomBytes(32).toString('hex'), salt, SCRYPT_KEYLEN).toString('hex');
    db.prepare('INSERT INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)')
      .run(LOCAL_USER_ID, 'local-desktop', hash, salt);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function passwordMatches(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function registerUser(db, username, password) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(cleanUsername)) {
    throw Object.assign(new Error('Username must be 3-32 characters: letters, numbers, - or _.'), { status: 400 });
  }
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) throw Object.assign(new Error('That username is already taken.'), { status: 409 });
  const { hash, salt } = hashPassword(password);
  const userId = db.prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)')
    .run(cleanUsername, hash, salt).lastInsertRowid;
  return issueToken(db, userId);
}

export function loginUser(db, username, password) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  const userRow = db.prepare('SELECT id, password_hash, password_salt FROM users WHERE username = ?').get(cleanUsername);
  if (!userRow || !passwordMatches(String(password || ''), userRow.password_salt, userRow.password_hash)) {
    throw Object.assign(new Error('Incorrect username or password.'), { status: 401 });
  }
  return issueToken(db, userRow.id);
}

function issueToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)').run(token, userId);
  return { token, userId };
}

export function requireAuth(db) {
  return (req, res, next) => {
    if (!MULTI_USER) { req.userId = LOCAL_USER_ID; return next(); }
    if (OPEN_ROUTES.has(req.path)) return next();
    const header = String(req.get('Authorization') || '');
    const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header);
    if (!match) return res.status(401).json({ ok: false, error: 'Sign in required.' });
    const tokenRow = db.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(match[1]);
    if (!tokenRow) return res.status(401).json({ ok: false, error: 'Your session has expired. Sign in again.' });
    db.prepare('UPDATE auth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?').run(match[1]);
    req.userId = tokenRow.user_id;
    return next();
  };
}

const OPEN_ROUTES = new Set(['/api/auth/register', '/api/auth/login', '/api/health', '/api/version', '/api/csrf-token']);
