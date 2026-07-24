// Question bank loader + dealing rules.
//
// questions.json is the editable source of truth (the /questions admin page
// writes it back). Shape per entry:
//   { id, category, difficulty, question, answer, altAnswers[], decoys[],
//     source: {season, episode}, verified }
//
// There are no multiple-choice fields — players type a sincere answer and the
// server judges it (see judge.js). `altAnswers` is what tier-1 matching checks
// alongside `answer`; `decoys` pad thin ballots and feed the random-bluff
// button.
//
// Dealing rules:
//   - only `verified: true` questions are served, unless the room's
//     allowUnverified dev setting is on
//   - never repeat inside a game (room-level used set)
//   - never repeat for a signed-in account across games (caller passes the
//     account's seen ids), degrading gracefully when the pool runs dry

const fs = require('fs');
const path = require('path');

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

let ALL = [];
let CATEGORIES = [];

// Accepts either a bare array or the starter file's { note, questions } wrapper
// so the admin page and the shipped bank can both be read back safely.
function parse(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.questions)) return raw.questions;
  return [];
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('[questions] could not read questions.json:', e.message);
    ALL = [];
    CATEGORIES = [];
    return;
  }
  const seen = new Set();
  const out = [];
  for (const q of parse(raw)) {
    const why = validate(q, seen);
    if (why) {
      console.warn('[questions] skipping', (q && q.id) || '(no id)', '—', why);
      continue;
    }
    seen.add(q.id);
    out.push({
      id: q.id,
      category: q.category,
      difficulty: Number(q.difficulty) || 2,
      question: q.question.trim(),
      answer: q.answer.trim(),
      altAnswers: (q.altAnswers || []).filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()),
      decoys: (q.decoys || []).filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim()),
      source: q.source || { season: null, episode: null },
      verified: !!q.verified,
      // Play stats, surfaced on the admin page. Persisted back by recordPlay().
      stats: q.stats || { served: 0, correct: 0, answered: 0, topWrong: {} }
    });
  }
  ALL = out;
  CATEGORIES = [...new Set(out.map((q) => q.category))].sort();
  const verified = out.filter((q) => q.verified).length;
  console.log('[questions] loaded ' + out.length + ' questions across ' +
    CATEGORIES.length + ' categories — ' + verified + ' verified');
  if (!verified) {
    console.warn('[questions] NONE are verified yet. Real games serve only ' +
      'verified questions; rooms need the allowUnverified dev setting until ' +
      'you approve some at /questions.');
  }
}

function validate(q, seenIds) {
  if (!q || typeof q !== 'object') return 'not an object';
  if (typeof q.id !== 'string' || !q.id) return 'missing id';
  if (seenIds.has(q.id)) return 'duplicate id';
  if (typeof q.category !== 'string' || !q.category.trim()) return 'missing category';
  if (typeof q.question !== 'string' || q.question.trim().length < 6) return 'missing question text';
  if (typeof q.answer !== 'string' || !q.answer.trim()) return 'missing answer';
  return null;
}

load();

// ─── dealing ───

// Pick the next question for a room.
//   used:            Set of ids already served this game
//   accountSeen:     Set of ids the signed-in players have already had (union
//                    across the table) — avoided when possible, ignored when
//                    honouring it would leave nothing to serve
//   categories:      array of category names the lobby left switched on
//   allowUnverified: dev setting; when false only verified questions are served
//
// Returns null only when there is genuinely nothing left to serve, so the
// caller can end the game cleanly rather than looping.
function draw({ used, accountSeen = null, categories = null, allowUnverified = false } = {}) {
  const usedSet = used instanceof Set ? used : new Set();
  const allowed = Array.isArray(categories) && categories.length ? new Set(categories) : null;

  const eligible = ALL.filter((q) =>
    (allowUnverified || q.verified) &&
    !usedSet.has(q.id) &&
    (!allowed || allowed.has(q.category)));

  if (!eligible.length) return null;

  // Prefer questions nobody at the table has seen before. If that empties the
  // pool, fall back to the room-level filter rather than refusing to deal —
  // a repeat for one player beats stalling the game.
  let pool = eligible;
  if (accountSeen instanceof Set && accountSeen.size) {
    const fresh = eligible.filter((q) => !accountSeen.has(q.id));
    if (fresh.length) pool = fresh;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// How many questions a given filter can supply — the lobby uses this to stop
// players switching off so many categories that a board can't be played out.
function countFor({ categories = null, allowUnverified = false } = {}) {
  const allowed = Array.isArray(categories) && categories.length ? new Set(categories) : null;
  return ALL.filter((q) =>
    (allowUnverified || q.verified) && (!allowed || allowed.has(q.category))).length;
}

function all() { return ALL; }
function categories() { return CATEGORIES.slice(); }
function byId(id) { return ALL.find((q) => q.id === id) || null; }

// ─── persistence (admin page + play stats) ───

function writeAll(list) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(list, null, 2) + '\n');
  load();
}

// Fold one round's outcome into a question's stats so the admin page can show
// which questions play too easy or too hard, and which wrong answer fooled the
// most people. Written through to disk so the numbers survive a restart.
function recordPlay(id, { answered = 0, correct = 0, wrongAnswers = [] } = {}) {
  const list = parse(JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')));
  const q = list.find((x) => x.id === id);
  if (!q) return;
  const s = q.stats || (q.stats = { served: 0, correct: 0, answered: 0, topWrong: {} });
  s.served += 1;
  s.answered += answered;
  s.correct += correct;
  for (const w of wrongAnswers) {
    const key = String(w).slice(0, 80);
    s.topWrong[key] = (s.topWrong[key] || 0) + 1;
  }
  try { writeAll(list); } catch (e) { console.warn('[questions] stat write failed:', e.message); }
}

// The AI judge calls this when tier 3 ruled a phrasing correct that tiers 1–2
// missed. It lands as a *suggestion* on the admin page — never auto-applied,
// because a bad suggestion would permanently widen what counts as correct.
function suggestAltAnswer(id, phrasing) {
  const list = parse(JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')));
  const q = list.find((x) => x.id === id);
  if (!q) return;
  const clean = String(phrasing || '').trim().slice(0, 120);
  if (!clean) return;
  q.suggestedAltAnswers = q.suggestedAltAnswers || [];
  const already = q.suggestedAltAnswers.some((s) => s.text.toLowerCase() === clean.toLowerCase())
    || (q.altAnswers || []).some((a) => a.toLowerCase() === clean.toLowerCase());
  if (already) return;
  q.suggestedAltAnswers.push({ text: clean, at: Date.now() });
  try { writeAll(list); } catch (e) { console.warn('[questions] suggestion write failed:', e.message); }
}

module.exports = {
  draw,
  countFor,
  all,
  categories,
  byId,
  writeAll,
  recordPlay,
  suggestAltAnswer,
  reload: load,
  total: () => ALL.length
};
