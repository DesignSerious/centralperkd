// Player accounts + cross-game stats.
//
// Storage is a single SQLite file (built-in node:sqlite — no dependency).
// Default path: server/data/friends-trivia.db, overridable via
// FRIENDS_TRIVIA_DB.
// NOTE: like playlist.json / uploads, this file is on the local disk, which
// is ephemeral on Railway across redeploys — mount a persistent volume (or
// point FRIENDS_TRIVIA_DB at one) if you need accounts to survive deploys.
//
// Auth is deliberately light for a phones-in-the-room party game: a username
// + 4–6 digit PIN. The PIN is scrypt-hashed; sign-in returns a stateless
// HMAC token the phone keeps in localStorage. Guests never touch this module.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.FRIENDS_TRIVIA_DB || path.join(__dirname, 'data', 'friends-trivia.db');

// node:sqlite is built into Node >=22.5 (flag-free on Node 24). If the host
// somehow runs an older Node it won't exist — rather than crash the whole
// server on boot, disable accounts and keep the game fully playable. Tokens
// are pure crypto and still work; the DB-backed calls degrade (guards below).
let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      username_key  TEXT NOT NULL UNIQUE,
      pin           TEXT NOT NULL,
      avatar        TEXT,
      created_at    INTEGER NOT NULL,
      games_played    INTEGER NOT NULL DEFAULT 0,
      games_won       INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0,
      best_streak     INTEGER NOT NULL DEFAULT 0
    );
  `);
} catch (e) {
  console.error('[accounts] DISABLED — node:sqlite unavailable or DB open failed (needs Node >=22.5):', e.message);
  db = null;
}

// ─── Token (stateless, HMAC-signed) ───
const AUTH_SECRET = process.env.AUTH_SECRET || 'central-perkd-dev-secret-change-me';
if (!process.env.AUTH_SECRET) {
  console.warn('[auth] AUTH_SECRET not set — using a default. Set it in production so account tokens stay secret and survive restarts.');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function signToken(uid) {
  const payload = b64url(JSON.stringify({ uid, iat: Date.now() }));
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(b64urlToBuf(payload).toString('utf8'));
    return (obj && typeof obj.uid === 'string') ? obj.uid : null;
  } catch (e) { return null; }
}

// ─── PIN hashing (scrypt) ───
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function verifyPin(pin, stored) {
  try {
    const parts = String(stored).split('$');
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const h = crypto.scryptSync(String(pin), salt, expected.length);
    return h.length === expected.length && crypto.timingSafeEqual(h, expected);
  } catch (e) { return false; }
}

// ─── Validation ───
function cleanUsername(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (s.length < 3) throw new Error('Username must be at least 3 characters');
  if (s.length > 20) throw new Error('Username must be 20 characters or less');
  if (!/^[A-Za-z0-9 _-]+$/.test(s)) throw new Error('Username: letters, numbers, spaces, _ and - only');
  return s;
}
function cleanPin(raw) {
  const s = String(raw == null ? '' : raw);
  if (!/^[0-9]{4,6}$/.test(s)) throw new Error('PIN must be 4 to 6 digits');
  return s;
}
function usernameKey(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toLowerCase();
}

/* TWEN accounts sit alongside the PIN ones rather than replacing them: on a
   phone, mid-round, four digits beat an OAuth round trip, and guests still need
   no account at all. What TWEN adds is one identity across every TWEN game.
   Added by ALTER so an existing database gains the column without a migration. */
if (db) {
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('twen_id')) db.exec('ALTER TABLE users ADD COLUMN twen_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_twen_id ON users(twen_id) WHERE twen_id IS NOT NULL');
  } catch (e) {
    console.error('[accounts] could not add twen_id:', e.message);
  }
}

// ─── Queries ─── (null when accounts are disabled; every caller guards on it)
const Q = db ? {
  byKey: db.prepare('SELECT * FROM users WHERE username_key = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byTwen: db.prepare('SELECT * FROM users WHERE twen_id = ?'),
  insertTwen: db.prepare('INSERT INTO users (id, username, username_key, pin, avatar, created_at, twen_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  linkTwen: db.prepare('UPDATE users SET twen_id = ? WHERE id = ?'),
  insert: db.prepare('INSERT INTO users (id, username, username_key, pin, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  game: db.prepare('UPDATE users SET games_played = games_played + 1, games_won = games_won + ?, correct_answers = correct_answers + ?, best_streak = max(best_streak, ?) WHERE id = ?')
} : null;
const ACCOUNTS_DOWN = 'Accounts are temporarily unavailable.';

function publicUser(row) {
  if (!row) return null;
  const gp = row.games_played || 0;
  const correct = row.correct_answers || 0;
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar || null,
    gamesPlayed: gp,
    gamesWon: row.games_won || 0,
    winRate: gp ? Math.round((row.games_won * 100) / gp) : 0,
    correctAnswers: correct,
    bestStreak: row.best_streak || 0,
    avgCorrect: gp ? Math.round(correct / gp) : 0
  };
}

// Throws Error (validation / "taken") on failure; returns public user.
function createUser(username, pin, avatar) {
  if (!Q) throw new Error(ACCOUNTS_DOWN);
  const name = cleanUsername(username);
  const p = cleanPin(pin);
  const key = name.toLowerCase();
  if (Q.byKey.get(key)) throw new Error('That username is taken');
  const id = crypto.randomBytes(8).toString('hex');
  Q.insert.run(id, name, key, hashPin(p), avatar || null, Date.now());
  return publicUser(Q.byId.get(id));
}

/* A TWEN identity, turned into a Central Perk'd profile. Seen before → that
   profile, stats and all; new → a profile with no usable PIN, under a free
   name derived from the Google one. Deliberately identical in behaviour to
   Wilderdash's, because the two share players and should not surprise them. */
function fromTwen(identity) {
  if (!Q) throw new Error(ACCOUNTS_DOWN);
  if (!identity || !identity.id) throw new Error('No TWEN identity');

  const seen = Q.byTwen.get(identity.id);
  if (seen) return publicUser(seen);

  let base = String(identity.name || (identity.email || '').split('@')[0] || 'Player')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
  if (base.length < 3) base = 'Player';

  let name = base, n = 1;
  while (Q.byKey.get(name.toLowerCase())) {
    const suffix = ' ' + (++n);
    name = base.slice(0, 20 - suffix.length) + suffix;
    if (n > 999) throw new Error('Could not find a free username');
  }

  const id = crypto.randomBytes(8).toString('hex');
  // The PIN column is NOT NULL; a hash of random bytes keeps it unusable, which
  // is the point — the way into this profile is TWEN.
  Q.insertTwen.run(id, name, name.toLowerCase(), hashPin(crypto.randomBytes(12).toString('hex')),
                   null, Date.now(), identity.id);
  return publicUser(Q.byId.get(id));
}

/* Claim an existing PIN profile for a TWEN account, so stats keep counting
   after switching to Google. Refuses if either side is already spoken for. */
function linkTwen(userId, twenId) {
  if (!Q) throw new Error(ACCOUNTS_DOWN);
  const row = Q.byId.get(userId);
  if (!row) throw new Error('No such profile');
  if (row.twen_id && row.twen_id !== twenId) throw new Error('That profile is already linked to another TWEN account');
  const taken = Q.byTwen.get(twenId);
  if (taken && taken.id !== userId) throw new Error('That TWEN account already has a profile here');
  Q.linkTwen.run(twenId, userId);
  return publicUser(Q.byId.get(userId));
}

// Returns public user on success, null on bad credentials.
function login(username, pin) {
  if (!Q) return null;
  const row = Q.byKey.get(usernameKey(username));
  if (!row || !verifyPin(pin, row.pin)) return null;
  return publicUser(row);
}

function getUser(id) {
  if (!Q) return null;
  return publicUser(Q.byId.get(id));
}

function setAvatar(id, avatar) {
  if (!Q || !id || !avatar) return;
  // Mirror the join-time validation envelope: stock id, photo data URL, or
  // an /ai-pieces/ URL. Anything else is ignored so we never store junk.
  const ok = /^[a-z0-9-]{1,40}$/i.test(avatar)
    || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)
    || /^\/ai-pieces\/[a-f0-9]+\.png$/.test(avatar);
  if (!ok) return;
  Q.setAvatar.run(avatar, id);
  return getUser(id);
}

// One finished game for one account: bumps games played, the win counter,
// their lifetime correct-answer total, and their best-ever streak.
function recordGame({ userId, won, correct, bestStreak }) {
  if (!Q || !userId) return;
  const c = Math.max(0, Math.round(Number(correct) || 0));
  const st = Math.max(0, Math.round(Number(bestStreak) || 0));
  Q.game.run(won ? 1 : 0, c, st, userId);
}

module.exports = {
  createUser,
  login,
  fromTwen,
  linkTwen,
  getUser,
  setAvatar,
  recordGame,
  signToken,
  verifyToken
};
