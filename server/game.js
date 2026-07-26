// Central Perk'd game state machine. All rooms live in memory in this module
// and never touch disk. A room is wiped 2 hours after the last activity.
//
// The round is an answer-first bluff game:
//
//   LOBBY -> ROUND_INTRO -> ANSWERING -> BLUFFING -> VOTING -> REVEAL ->
//   (REVIEW) -> SCORING -> (win check) -> ROUND_INTRO -> ... -> GAME_OVER
//
//   REVIEW     optional, only when a wrongly-judged player disputes their
//              answer during the reveal. The OTHER players vote yes/no; a
//              majority overturns it and that player is counted correct for
//              scoring. Bots never dispute and never judge, so a bot-only
//              game never enters this phase.
//
//   ANSWERING  every player types what they think the real answer is. Each
//              submission is judged the moment it lands (see judge.js), so
//              the AI call's latency hides inside the phase.
//   BLUFFING   only players who were RIGHT write a lie, for bonus spaces.
//              Wrong players' sincere guesses are already their ballot entry —
//              honest wrong answers make the funniest ballot. Skipped entirely
//              when nobody got it right.
//   VOTING     only players who were WRONG vote. Correct players already know
//              the truth, so they sit out (no double-dipping) and watch to see
//              who falls for their lie. Skipped when everyone was right.
//   REVEAL     the truth, who knew it, who fooled whom.
//   SCORING    points board lands, then pieces walk the board one at a time.
//   FACE_OFF   only when SCORING puts TWO OR MORE pieces on the couch at once.
//              Sudden death between them: one question, finalists only, fastest
//              correct answer takes the game. Nobody right, new question. See
//              beginFaceOff for why this exists instead of a tiebreak sort.
//
// State transitions are server-driven. Clients only emit actions; they never
// decide what comes next, never learn which ballot entry is the real answer,
// and never compute movement.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Questions = require('./questions');
const Judge = require('./judge');
const Board = require('./board');

const STATES = {
  LOBBY: 'LOBBY',
  ROUND_INTRO: 'ROUND_INTRO',
  ANSWERING: 'ANSWERING',
  BLUFFING: 'BLUFFING',
  VOTING: 'VOTING',
  REVEAL: 'REVEAL',
  REVIEW: 'REVIEW',
  SCORING: 'SCORING',
  FACE_OFF: 'FACE_OFF',
  GAME_OVER: 'GAME_OVER'
};

const ROOM_IDLE_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_PLAYERS = 8;

// "Give me one" on the ANSWER screen: a believable WRONG answer for a player
// who has drawn a blank, so they put something on the ballot instead of nothing.
// It never scores the answer points — it buys a lottery ticket on other people's
// votes. Two per game is what stops it becoming everyone's default move.
const RESCUES_PER_GAME = 2;

// ─── phase timings ───
const ROUND_INTRO_MS = 2600;
// Beat after the final submission so the last player's check-in ding and their
// checkmark land before the screen changes. Lifted from Wilderdash — small
// touch, big difference in feel.
const LAST_DING_BEAT_MS = 700;
// Every correct player wrote their lie during ANSWERING, so BLUFFING has
// nothing to wait for. It still gets a short hold rather than the 700ms ding
// beat: the players who missed the question have not seen "N of you knew it"
// yet, and flashing that card for two thirds of a second reads as a glitch.
const BLUFF_ALL_EARLY_MS = 1600;
// Leaving ANSWERING while an AI judgement is still in flight would misclassify
// that player (a genuinely-correct paraphrase gets stamped WRONG and loses its
// points), so we hold for stragglers before falling back to the tier-2 verdict.
// This MUST comfortably exceed judge.js AI_TIMEOUT_MS — otherwise a slow OpenAI
// call (routine from Railway) is abandoned mid-flight and the answer is scored
// wrong. The grace loops in 250ms steps and proceeds the instant every
// judgement resolves, so a fast round never actually waits this long.
const JUDGE_GRACE_MS = 7000;

// ─── couch face-off (sudden death) ───
// The intro card names the finalists before the first question, so the room
// understands why the game just stopped. Later legs skip it — the previous
// leg's result card already said "nobody got it, again".
const FACE_OFF_INTRO_MS = 4200;
const FACE_OFF_RESULT_MS = 5200;
// Sudden death runs on a shorter clock than a normal round: two people who both
// walked 32 spaces either know it or they don't, and a 40-second stare-down
// kills the moment. Capped rather than fixed so a lobby set to 20s stays at 20.
const FACE_OFF_ANSWER_CAP_S = 25;
// Backstop. Five questions with nobody right means the bank is fighting the
// table; fall back to a deterministic tiebreak rather than loop forever.
const FACE_OFF_MAX_LEGS = 5;

// REVEAL choreography: the truth card builds, lands, then each ballot entry is
// walked through so the room can see who wrote what.
const REVEAL_TRUTH_BUILD_MS = 3000;
const REVEAL_TRUTH_MS = 4200;
// The bluffs are shown all together on ONE page (not stepped through one at a
// time — that killed the momentum). A single dwell, scaled mildly with how many
// bluffs there are so a busy round stays readable. See revealMsForCurrent.
const REVEAL_BLUFFS_BASE_MS = 3200;
const REVEAL_BLUFFS_PER_MS = 650;
const REVEAL_BLUFFS_MAX_MS = 6500;
// Sentinel entry in revealOrder for the single "who fooled who" summary step.
const BLUFFS_STEP = '__BLUFFS__';

// REVIEW: a disputed answer is put to the other players. They get REVIEW_SECONDS
// to vote yes/no, then the verdict holds on screen for REVIEW_RESULT_MS before
// the next dispute (or scoring).
const REVIEW_SECONDS = 20;
const REVIEW_RESULT_MS = 2800;

// SCORING choreography. The points board lands (with its sound) and holds with
// every piece frozen for SLIDE_LEAD_MS; then the card fades, positions apply,
// and Board2D walks piece 0 for SLIDE_MS, piece 1 SLIDE_STAGGER_MS later, and
// so on. SLIDE_MS / SLIDE_STAGGER_MS MUST match Board2D's WAAPI controller or
// the audio drifts out of sync with the motion.
const SLIDE_MS = 1700;
const SLIDE_LEAD_MS = 4600;
const SLIDE_STAGGER_MS = 1000;
const SCORING_VIEW_MS = 1200;
// An arrow landing is a two-leg move on the TV: walk onto the arrow (SLIDE_MS),
// STOP + announce (ADV_PAUSE_MS), then hop the bonus (ADV_HOP_MS). It holds the
// spotlight the whole time, so each arrow mover adds this much to the phase
// beyond a normal one-space walk. MUST match Board2D's ADV_PAUSE_MS/ADV_HOP_MS:
// extra = (SLIDE_MS + ADV_PAUSE_MS + ADV_HOP_MS) - SLIDE_STAGGER_MS.
const ADV_PAUSE_MS = 1000;
const ADV_HOP_MS = 1300;
const ADVANCE_EXTRA_MS = (SLIDE_MS + ADV_PAUSE_MS + ADV_HOP_MS) - SLIDE_STAGGER_MS;

// Simulation mode blasts through the slow beats so a solo test of the full
// loop finishes in about a minute.
const SIM = {
  ROUND_INTRO_MS: 700,
  ANSWER_MS: 4000,
  BLUFF_MS: 3000,
  VOTE_MS: 4000,
  REVEAL_TRUTH_MS: 900,
  REVEAL_BLUFFS_MS: 900,
  SCORING_MS: 2200
};

// ─── movement rules (all lobby-tunable via settings) ───
const DEFAULT_SETTINGS = {
  boardSpaces: Board.DEFAULT_LENGTH,   // 16 / 32 / 48 — only 32 matches the painted board
  answerSeconds: 40,
  bluffSeconds: 30,
  voteSeconds: 25,
  categories: [],                      // [] = every category in the bank
  // Movement values. These must NOT all be equal or every round pays the same
  // and the board never separates — the first playtest had a table where
  // knowing the answer (+2) and merely voting well (+2) moved you identically,
  // so three players sat on the same square for five rounds. Knowing it is now
  // the single best outcome, fooling people scales past it, and a lucky vote is
  // a consolation rather than an equal.
  pointsCorrectAnswer: 3,              // you knew it — the strongest single play
  pointsPerVote: 2,                    // each vote your ballot entry pulls
  pointsFoundTruth: 1,                 // you missed, but you spotted the truth
  bonusTileMultiplier: 2,              // coffee-cup tile doubles your next correct answer
  // Optional: when NO voter finds the truth, the players who knew it get this
  // many extra spaces. Off by default — it rewards a round where the table was
  // collectively fooled, which is fun but swingy.
  pointsNobodyFoundTruth: 0,
  finalRoundToClinch: false,           // reaching FINISH must be backed by points that round
  allowReviews: true,                  // a wrongly-judged player may dispute; the table votes to overturn
  allowUnverified: true                // DEV: the starter bank is all verified:false,
                                       // so this must stay on until questions are
                                       // approved at /questions. Flip to false for
                                       // real games.
};

const ANSWER_SECONDS_CHOICES = [20, 25, 40];
const BLUFF_SECONDS_CHOICES = [15, 20, 30];
const VOTE_SECONDS_CHOICES = [20, 25, 40];

// ─── settings validation + persistent operator defaults ───
// One validator, shared by the lobby's live updateSettings AND the /admin
// defaults editor: returns `base` with only the VALID fields of `patch` applied.
// Anything out of range/choice is dropped, so a partial or hostile payload can
// never put a room into a bad state.
function sanitizeSettings(patch, base) {
  const s = patch || {};
  const out = { ...base };
  if (Board.BOARD_LENGTHS.includes(s.boardSpaces)) out.boardSpaces = s.boardSpaces;
  if (ANSWER_SECONDS_CHOICES.includes(s.answerSeconds)) out.answerSeconds = s.answerSeconds;
  if (BLUFF_SECONDS_CHOICES.includes(s.bluffSeconds)) out.bluffSeconds = s.bluffSeconds;
  if (VOTE_SECONDS_CHOICES.includes(s.voteSeconds)) out.voteSeconds = s.voteSeconds;
  if (typeof s.finalRoundToClinch === 'boolean') out.finalRoundToClinch = s.finalRoundToClinch;
  if (typeof s.allowReviews === 'boolean') out.allowReviews = s.allowReviews;
  if (typeof s.allowUnverified === 'boolean') out.allowUnverified = s.allowUnverified;
  for (const k of ['pointsCorrectAnswer', 'pointsPerVote', 'pointsFoundTruth', 'pointsNobodyFoundTruth', 'bonusTileMultiplier']) {
    if (Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 10) out[k] = s[k];
  }
  if (Array.isArray(s.categories)) {
    const valid = s.categories.filter((c) => Questions.categories().includes(c));
    // Refuse a category filter too narrow to fill a board (judged against the
    // resulting board length + unverified setting).
    const supply = Questions.countFor({ categories: valid, allowUnverified: out.allowUnverified });
    if (supply >= Math.min(12, out.boardSpaces)) out.categories = valid;
  }
  return out;
}

// Operator-configured defaults every new room starts from (set at /admin). A
// missing/partial file safely falls back to DEFAULT_SETTINGS via sanitizeSettings.
const GAME_SETTINGS_FILE = path.join(__dirname, 'game-settings.json');
function readDefaults() {
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(GAME_SETTINGS_FILE, 'utf8')); } catch (e) {}
  return sanitizeSettings(persisted, DEFAULT_SETTINGS);
}
function writeDefaults(patch) {
  const next = sanitizeSettings(patch, readDefaults());
  try { fs.writeFileSync(GAME_SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch (e) {}
  return next;
}
// Option lists for the /admin form, so it renders the exact valid choices.
function settingsMeta() {
  return {
    allCategories: Questions.categories(),
    choices: {
      boardSpaces: Board.BOARD_LENGTHS,
      answerSeconds: ANSWER_SECONDS_CHOICES,
      bluffSeconds: BLUFF_SECONDS_CHOICES,
      voteSeconds: VOTE_SECONDS_CHOICES
    }
  };
}

const rooms = new Map();

// ─── code generation ───
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // skip I, O for legibility
function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'X' + Date.now().toString(36).slice(-3).toUpperCase();
}

function newPlayerId() { return crypto.randomBytes(8).toString('hex'); }

function makeRoom(code) {
  return {
    code,
    state: STATES.LOBBY,
    // Start from the operator's saved defaults (set at /admin); the lobby can
    // still override per-game.
    settings: readDefaults(),
    players: [],
    tvSocketIds: new Set(),
    board: Board.buildBoard(DEFAULT_SETTINGS.boardSpaces),
    round: 0,
    question: null,          // the full question INCLUDING the answer — never sent whole to a phone
    answers: {},             // playerId -> { text, ms, correct, tier, judged }
    bluffs: {},              // playerId -> lie text (correct players only)
    ballot: [],              // [{ letter, text, authorIds[], isTruth, isDecoy }]
    votes: {},               // playerId -> letter (wrong players only)
    laughs: {},              // ballot letter -> [playerIds who reacted 😂 to it]
    answersOpenedAt: 0,
    judgeBudget: null,
    pendingJudgements: 0,
    revealIndex: 0,
    revealOrder: [],
    // Phones stay dark until the TV has finished its dramatic build and put
    // the real answer on screen. Gated server-side rather than by a client
    // timer so no amount of clock skew can let a phone spoil the room.
    truthRevealed: false,
    lastResults: {},         // playerId -> per-round breakdown
    lastSlides: {},          // playerId -> { from, to, dir }
    skipReason: null,        // 'everyone-knew' | 'nobody-knew' for the round just played
    // Answer-review (dispute) state. reviewRequests collects wrongly-judged
    // players who tapped "Request Review" during REVEAL; the queue drains one at
    // a time in REVIEW, reviewVotes holds the current dispute's yes/no ballot.
    reviewRequests: [],      // [playerId] queued during REVEAL
    reviewQueue: [],         // [playerId] left to resolve in REVIEW
    reviewCurrent: null,     // { playerId, name, piece, answerText, truth, resolved, passed, yes, no, voterCount }
    reviewVotes: {},         // playerId -> 'yes' | 'no' for the current dispute
    usedQuestions: new Set(),
    duelPending: null,       // { challengerId, opponentId } resolved next round
    duelPick: null,          // { playerId } owes us an opponent choice
    faceOff: null,           // sudden-death tiebreak on the couch — see beginFaceOff
    rescueOffers: {},        // playerId -> the wrong answer handed out this round
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    timer: null,
    timerFn: null,
    phaseEndsAt: null,
    paused: false,
    pausedRemainingMs: null,
    pausedTimerFn: null,
    botTimers: [],
    botMode: false,
    lastBotState: null,
    winnerId: null
  };
}

function touch(room) { room.lastActivityAt = Date.now(); }

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.timerFn = null;
  room.phaseEndsAt = null;
}

function setTimer(room, ms, fn) {
  clearTimer(room);
  room.phaseEndsAt = Date.now() + ms;
  room.timerFn = fn;
  room.timer = setTimeout(() => { room.timer = null; room.timerFn = null; room.phaseEndsAt = null; fn(); }, ms);
}

function trackedBotTimeout(room, fn, ms) {
  if (!room.botTimers) room.botTimers = [];
  let id;
  id = setTimeout(() => {
    if (room.botTimers) {
      const i = room.botTimers.indexOf(id);
      if (i >= 0) room.botTimers.splice(i, 1);
    }
    fn();
  }, ms);
  room.botTimers.push(id);
  return id;
}

function clearBotTimers(room) {
  if (!room.botTimers) return;
  for (const id of room.botTimers) clearTimeout(id);
  room.botTimers = [];
}

function pauseGame(io, room) {
  if (room.paused) return false;
  if (!room.timer || !room.timerFn) return false;
  room.pausedRemainingMs = Math.max(0, (room.phaseEndsAt || Date.now()) - Date.now());
  room.pausedTimerFn = room.timerFn;
  clearTimer(room);
  clearBotTimers(room);
  room.paused = true;
  touch(room);
  broadcast(io, room.code);
  return true;
}

function resumeGame(io, room) {
  if (!room.paused) return false;
  const fn = room.pausedTimerFn;
  const remaining = room.pausedRemainingMs;
  room.paused = false;
  room.pausedTimerFn = null;
  room.pausedRemainingMs = null;
  if (fn && remaining != null) setTimer(room, remaining, fn);
  room.lastBotState = null;
  touch(room);
  broadcast(io, room.code);
  if (room.players.some((p) => p.isBot)) {
    room.lastBotState = room.state;
    scheduleBotActions(io, room);
  }
  return true;
}

// ─── public api ───
function roomCount() { return rooms.size; }
function getRoom(code) { return rooms.get(code) || null; }

function peekRoom(code) {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: 'Room not found' };
  return {
    ok: true,
    code: room.code,
    state: room.state,
    takenPieces: room.players.map((p) => p.piece).filter((x) => x && !x.startsWith('data:image/')),
    playerCount: room.players.length
  };
}

function createRoom(tvSocketId) {
  const code = newCode();
  const room = makeRoom(code);
  room.tvSocketIds.add(tvSocketId);
  rooms.set(code, room);
  return room;
}

function joinRoom({ code, name, piece, existingPlayerId, socketId, userId }) {
  const room = rooms.get(code);
  if (!room) throw new Error('Room not found');

  if (existingPlayerId) {
    const p = room.players.find((x) => x.id === existingPlayerId);
    if (p) {
      p.socketId = socketId;
      p.connected = true;
      if (name) p.name = capitalizeFirst(String(name).trim()).slice(0, 20);
      if (piece) p.piece = piece;
      if (userId) p.userId = userId;
      touch(room);
      return { code: room.code, playerId: p.id };
    }
  }

  if (room.state !== STATES.LOBBY && room.state !== STATES.GAME_OVER) {
    throw new Error('Game in progress, can\'t join mid-round');
  }
  if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full');
  if (!name) throw new Error('Pick a name');
  if (piece && !piece.startsWith('data:image/') && room.players.some((p) => p.piece === piece)) {
    throw new Error('That piece is taken');
  }

  const id = newPlayerId();
  room.players.push({
    id,
    socketId,
    name: capitalizeFirst(String(name).trim()).slice(0, 20),
    piece: piece || null,
    position: 0,
    correct: 0,          // correct answers this game
    fooled: 0,           // votes pulled by this player's entries this game
    streak: 0,
    bestStreak: 0,
    doubleNext: false,   // armed by a bonus tile
    connected: true,
    userId: userId || null
  });
  touch(room);
  return { code: room.code, playerId: id };
}

// ─── state transitions ───
function startGame(io, room) {
  if (room.state !== STATES.LOBBY && room.state !== STATES.GAME_OVER) return;
  if (room.players.length < 2) return;
  room.board = Board.buildBoard(room.settings.boardSpaces);
  room.players.forEach((p) => {
    p.position = 0;
    p.correct = 0;
    p.fooled = 0;
    p.streak = 0;
    p.bestStreak = 0;
    p.doubleNext = false;
  });
  room.round = 0;
  room.winnerId = null;
  room.usedQuestions = new Set();
  room.duelPending = null;
  room.duelPick = null;
  room.lastResults = {};
  room.lastSlides = {};
  beginRoundIntro(io, room);
}

function beginRoundIntro(io, room) {
  clearTimer(room);
  room.round += 1;
  room.answers = {};
  room.bluffs = {};
  room.ballot = [];
  room.votes = {};
  room.laughs = {};
  room.lastResults = {};
  room.lastSlides = {};
  room.revealIndex = 0;
  room.revealOrder = [];
  room.truthRevealed = false;
  room.reviewRequests = [];
  room.reviewQueue = [];
  room.reviewCurrent = null;
  room.reviewVotes = {};
  room.judgeBudget = Judge.newRoundBudget();
  room.pendingJudgements = 0;
  room.skipReason = null;

  // A duel space landed on last round becomes this round's duel, now that its
  // challenger has picked (or been auto-assigned) an opponent.
  room.duelPending = room.duelPick && room.duelPick.opponentId
    ? { challengerId: room.duelPick.playerId, opponentId: room.duelPick.opponentId }
    : null;
  room.duelPick = null;

  const q = dealQuestion(room);
  if (!q) {
    // Nothing left to serve — end on current standings rather than looping.
    beginGameOver(io, room, { reason: 'out-of-questions' });
    return;
  }
  room.question = q;
  room.usedQuestions.add(q.id);
  for (const p of room.players) {
    if (p.userId && onQuestionServed) {
      try { onQuestionServed(p.userId, q.id); } catch (e) {}
    }
  }

  room.state = STATES.ROUND_INTRO;
  touch(room);
  setTimer(room, room.botMode ? SIM.ROUND_INTRO_MS : ROUND_INTRO_MS, () => beginAnswering(io, room));
  broadcast(io, room.code);
}

// Hook so index.js can record per-account question history without this module
// touching the DB.
let onQuestionServed = null;
let accountSeenQuestions = null;
function setQuestionHooks({ onServed, seenFor }) {
  onQuestionServed = typeof onServed === 'function' ? onServed : null;
  accountSeenQuestions = typeof seenFor === 'function' ? seenFor : null;
}

function dealQuestion(room) {
  // Union of what every signed-in player at the table has already seen, so a
  // returning player doesn't get the same question twice across games.
  let accountSeen = null;
  if (accountSeenQuestions) {
    accountSeen = new Set();
    for (const p of room.players) {
      if (!p.userId) continue;
      try { for (const id of accountSeenQuestions(p.userId)) accountSeen.add(id); } catch (e) {}
    }
  }
  return Questions.draw({
    used: room.usedQuestions,
    accountSeen,
    categories: room.settings.categories,
    allowUnverified: room.settings.allowUnverified
  });
}

function beginAnswering(io, room) {
  clearTimer(room);
  room.state = STATES.ANSWERING;
  room.answers = {};
  room.answersOpenedAt = Date.now();
  touch(room);
  setTimer(room, room.settings.answerSeconds * 1000, () => closeAnswering(io, room));
  broadcast(io, room.code);
}

// A phone submitted its sincere answer. Judged immediately; the verdict is
// private to that player until REVEAL.
async function submitAnswer(io, room, playerId, text) {
  if (room.state !== STATES.ANSWERING) return { ok: false, error: 'Not accepting answers' };
  if (room.answers[playerId]) return { ok: false, error: 'You already answered' };
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) return { ok: false, error: 'Type your answer.' };

  // Record first (so the TV's check-in strip updates instantly), judge after.
  const entry = { text: clean, ms: Date.now() - room.answersOpenedAt, correct: false, tier: 0, judged: false };
  room.answers[playerId] = entry;
  room.pendingJudgements += 1;
  touch(room);
  broadcast(io, room.code);

  let verdict = { correct: false, tier: 2 };
  try {
    verdict = await Judge.judgeAnswer(clean, room.question, room.judgeBudget);
  } catch (e) {
    console.error('[judge] threw, treating as wrong:', e.message);
  }
  entry.correct = !!verdict.correct;
  entry.tier = verdict.tier;
  entry.judged = true;
  room.pendingJudgements = Math.max(0, room.pendingJudgements - 1);

  // The room may have moved on while the AI call was in flight.
  if (room.state === STATES.ANSWERING) {
    broadcast(io, room.code);
    const expected = room.players.filter((p) => p.connected);
    if (expected.every((p) => room.answers[p.id] && room.answers[p.id].judged)) {
      setTimer(room, LAST_DING_BEAT_MS, () => closeAnswering(io, room));
    }
  }
  return { ok: true, correct: entry.correct };
}

// Wait out any in-flight AI judgement (briefly) so nobody is misclassified by
// a race, then move on.
function closeAnswering(io, room, waited = 0) {
  if (room.state !== STATES.ANSWERING) return;
  if (room.pendingJudgements > 0 && waited < JUDGE_GRACE_MS) {
    setTimer(room, 250, () => closeAnswering(io, room, waited + 250));
    return;
  }
  if (room.pendingJudgements > 0) {
    console.warn('[judge] ' + room.pendingJudgements + ' judgement(s) still pending after grace — using tier-2 verdicts');
    room.pendingJudgements = 0;
  }
  const correctIds = correctPlayerIds(room);
  const connected = room.players.filter((p) => p.connected).length;
  room.skipReason = null;
  // Nobody knew it → no lies to write; everyone votes on the honest guesses.
  if (!correctIds.length) { room.skipReason = 'nobody-knew'; beginVoting(io, room); return; }
  // Everyone knew it → there is literally no one left to fool, so there is no
  // bluff to write and no vote to hold. This is the ONLY case where a correct
  // player doesn't get their bluff, and the TV/phone now say so explicitly —
  // silently skipping it read as a bug in playtesting.
  if (correctIds.length >= connected) {
    room.skipReason = 'everyone-knew';
    // Drop any lie written early — with nobody left to fool there is no vote,
    // so an early bluff would otherwise turn up on the reveal having never been
    // on a ballot.
    room.bluffs = {};
    beginReveal(io, room);
    return;
  }
  beginBluffing(io, room);
}

// A correct player doesn't wait for the answer clock. The judge clears them the
// moment their answer lands, and from that instant their bluff window is open —
// they write their lie while everyone else is still typing. BLUFFING is then
// just the phase where the rest of the right-answerers catch up.
function bluffWindowOpen(room, playerId) {
  if (room.state === STATES.BLUFFING) return true;
  if (room.state !== STATES.ANSWERING) return false;
  const a = room.answers[playerId];
  return !!(a && a.judged && a.correct);
}

function correctPlayerIds(room) {
  return room.players
    .filter((p) => p.connected && room.answers[p.id] && room.answers[p.id].correct)
    .map((p) => p.id);
}
function wrongPlayerIds(room) {
  return room.players
    .filter((p) => p.connected && !(room.answers[p.id] && room.answers[p.id].correct))
    .map((p) => p.id);
}

function beginBluffing(io, room) {
  clearTimer(room);
  room.state = STATES.BLUFFING;
  // room.bluffs is deliberately NOT cleared here. Correct players write their
  // lie during ANSWERING now (see bluffWindowOpen), and those early entries have
  // to survive the phase change. beginRoundIntro already clears it per round.
  touch(room);
  // Everyone who knew it lied while the others were still answering — there is
  // nothing to wait for, so take the beat and move to the vote.
  const waiting = correctPlayerIds(room).filter((id) => !room.bluffs[id]);
  setTimer(
    room,
    waiting.length
      ? (room.botMode ? SIM.BLUFF_MS / 1000 : room.settings.bluffSeconds) * 1000
      : (room.botMode ? LAST_DING_BEAT_MS : BLUFF_ALL_EARLY_MS),
    () => beginVoting(io, room)
  );
  broadcast(io, room.code);
}

// A correct player's crafted lie. Rejected if it's really the truth wearing a
// hat — the ballot must never contain two true answers.
async function submitBluff(io, room, playerId, text) {
  if (!bluffWindowOpen(room, playerId)) return { ok: false, error: 'Not accepting lies' };
  const answer = room.answers[playerId];
  if (!answer || !answer.correct) return { ok: false, error: 'Only players who got it right write a lie' };
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) return { ok: false, error: 'Write a lie to fool the others.' };

  let tooClose = false;
  try {
    tooClose = await Judge.isTooCloseToTruth(clean, room.question, room.judgeBudget);
  } catch (e) {}
  if (tooClose) {
    return { ok: false, error: "That's the real answer — you already got your points for it! Write a LIE." };
  }
  // Don't let a lie duplicate this player's own (wrong-looking) answer or an
  // existing lie in a way that would collapse the ballot to nothing.
  room.bluffs[playerId] = clean;
  touch(room);
  broadcast(io, room.code);

  const expected = correctPlayerIds(room).filter((id) => {
    const p = room.players.find((x) => x.id === id);
    return p && p.connected;
  });
  if (expected.every((id) => room.bluffs[id])) {
    setTimer(room, LAST_DING_BEAT_MS, () => beginVoting(io, room));
  }
  return { ok: true };
}

// The random-bluff rescue: hand the player one of the question's house decoys.
function randomBluff(room, playerId) {
  const q = room.question;
  if (!q) return null;
  const taken = new Set(Object.values(room.bluffs).map((t) => Judge.normalize(t)));
  const pool = (q.decoys || []).filter((d) => !taken.has(Judge.normalize(d)));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Build the shuffled ballot: the truth + every wrong player's sincere answer +
// every correct player's crafted lie, merged where near-identical, padded with
// house decoys when it would otherwise be too thin to be a real vote.
const MIN_BALLOT_ENTRIES = 3;
function buildBallot(room) {
  const q = room.question;
  const entries = [];

  function addEntry(text, authorId, opts = {}) {
    const existing = entries.find((e) => Judge.sameAnswer(e.text, text));
    if (existing) {
      // Two players landed on the same guess — one entry, shared credit.
      if (authorId && !existing.authorIds.includes(authorId)) existing.authorIds.push(authorId);
      return;
    }
    entries.push({
      text,
      authorIds: authorId ? [authorId] : [],
      isTruth: !!opts.isTruth,
      isDecoy: !!opts.isDecoy
    });
  }

  // Truth first so nothing else can merge into its slot and steal it.
  addEntry(q.answer, null, { isTruth: true });

  // Wrong players' sincere guesses.
  for (const p of room.players) {
    const a = room.answers[p.id];
    if (!a || a.correct) continue;
    addEntry(a.text, p.id);
  }
  // Correct players' crafted lies.
  for (const [pid, lie] of Object.entries(room.bluffs)) {
    addEntry(lie, pid);
  }
  // Pad a thin ballot with house decoys so a voter always has a real choice.
  for (const d of q.decoys || []) {
    if (entries.length >= MIN_BALLOT_ENTRIES) break;
    addEntry(d, null, { isDecoy: true });
  }

  shuffleInPlace(entries);
  room.ballot = entries.map((e, i) => ({
    letter: String.fromCharCode(65 + i),
    text: capitalizeFirst(e.text),
    authorIds: e.authorIds,
    isTruth: e.isTruth,
    isDecoy: e.isDecoy
  }));
  room.votes = {};
}

function beginVoting(io, room) {
  clearTimer(room);
  buildBallot(room);
  room.state = STATES.VOTING;
  touch(room);
  setTimer(room, (room.botMode ? SIM.VOTE_MS / 1000 : room.settings.voteSeconds) * 1000,
    () => beginReveal(io, room));
  broadcast(io, room.code);
}

function castVote(io, room, playerId, letter) {
  if (room.state !== STATES.VOTING) return false;
  const answer = room.answers[playerId];
  // Correct players sit out — they already know the truth.
  if (answer && answer.correct) return false;
  const choice = room.ballot.find((b) => b.letter === letter);
  if (!choice) return false;
  // Can't vote for your own entry.
  if (choice.authorIds.includes(playerId)) return false;

  room.votes[playerId] = letter;
  touch(room);
  broadcast(io, room.code);

  const voters = room.players.filter((p) => p.connected &&
    !(room.answers[p.id] && room.answers[p.id].correct));
  if (voters.every((p) => room.votes[p.id])) {
    setTimer(room, LAST_DING_BEAT_MS, () => beginReveal(io, room));
  }
  return true;
}

// 😂 react on a ballot entry during voting — "that made me laugh". Toggles the
// player's laugh on that entry; credited to the entry's author at the reveal.
// You can't laugh at your own entry.
function toggleLaugh(io, room, playerId, letter) {
  if (room.state !== STATES.VOTING) return false;
  const entry = room.ballot.find((b) => b.letter === letter);
  if (!entry) return false;
  if ((entry.authorIds || []).includes(playerId)) return false;   // not your own
  if (!Array.isArray(room.laughs[letter])) room.laughs[letter] = [];
  const arr = room.laughs[letter];
  const i = arr.indexOf(playerId);
  if (i >= 0) arr.splice(i, 1); else arr.push(playerId);
  touch(room);
  broadcast(io, room.code);
  return true;
}

// Who got laughed WITH this round: sum each ballot entry's 😂 count onto its
// author(s). Shown at the reveal. (Truth / house decoys have no author.)
function laughLeaders(room) {
  const byPlayer = {};
  for (const b of room.ballot) {
    const n = (room.laughs[b.letter] || []).length;
    if (!n) continue;
    for (const authorId of (b.authorIds || [])) {
      byPlayer[authorId] = (byPlayer[authorId] || 0) + n;
    }
  }
  return room.players
    .filter((p) => byPlayer[p.id])
    .map((p) => ({ id: p.id, name: p.name, piece: p.piece, laughs: byPlayer[p.id] }))
    .sort((a, b) => b.laughs - a.laughs);
}

function beginReveal(io, room) {
  clearTimer(room);
  if (!room.ballot.length) buildBallot(room);  // "everyone was right" path
  computeResults(room);
  recordQuestionStats(room);

  // TWO beats, to keep the game moving: the truth (with its dramatic build),
  // then a SINGLE page showing every bluff and who it fooled. Stepping through
  // bluffs one at a time slowed the momentum too much.
  room.revealOrder = [];
  const truth = room.ballot.find((b) => b.isTruth);
  if (truth) room.revealOrder.push(truth.letter);
  if (bluffsForReveal(room).length) room.revealOrder.push(BLUFFS_STEP);

  room.state = STATES.REVEAL;
  room.revealIndex = 0;
  room.truthRevealed = false;
  touch(room);
  // First broadcast: the TV starts its build; phones get a holding screen and
  // are told nothing about the answer yet.
  broadcast(io, room.code);

  const buildMs = room.botMode ? 0 : REVEAL_TRUTH_BUILD_MS;
  if (buildMs > 0) {
    setTimer(room, buildMs, () => {
      // The TV's truth card has landed — now the phones may show it.
      room.truthRevealed = true;
      touch(room);
      broadcast(io, room.code);
      scheduleNextReveal(io, room);
    });
    return;
  }
  room.truthRevealed = true;
  scheduleNextReveal(io, room);
}

// Bluff entries worth showing on the reveal summary: not the truth, and either
// authored by a player or voted for by someone. (Decoys nobody touched are dead
// air.) Used both to decide whether the summary step exists and to size its
// dwell.
function bluffsForReveal(room) {
  return room.ballot.filter((b) => !b.isTruth &&
    (b.authorIds.length || votersFor(room, b.letter).length));
}

function revealMsForCurrent(room) {
  if (room.botMode) {
    return room.revealIndex === 0 ? SIM.REVEAL_TRUTH_MS : SIM.REVEAL_BLUFFS_MS;
  }
  // Step 0 is the dwell on the truth card (the build is timed separately in
  // beginReveal — it gates the phones). Step 1, if present, is the single
  // "who fooled who" page: one dwell scaled mildly with the bluff count.
  if (room.revealIndex === 0) return REVEAL_TRUTH_MS;
  const n = bluffsForReveal(room).length;
  return Math.min(REVEAL_BLUFFS_MAX_MS, REVEAL_BLUFFS_BASE_MS + REVEAL_BLUFFS_PER_MS * n);
}

function scheduleNextReveal(io, room) {
  setTimer(room, revealMsForCurrent(room), () => {
    room.revealIndex += 1;
    touch(room);
    if (room.revealIndex >= room.revealOrder.length) {
      afterReveal(io, room);
    } else {
      broadcast(io, room.code);
      scheduleNextReveal(io, room);
    }
  });
}

// ─── answer review (dispute) ───
// Reviews are judged by the connected HUMANS only — CPU players never vote on a
// dispute. So a dispute needs at least two humans at the table (the disputer
// plus one to judge); a lone human playing against bots can't open one.
function connectedHumans(room) {
  return room.players.filter((p) => p.connected && !p.isBot);
}
// Who judges a given player's dispute: every OTHER connected human.
function reviewerIdsFor(room, disputerId) {
  return connectedHumans(room).filter((p) => p.id !== disputerId).map((p) => p.id);
}
// Live yes/no tally for the current dispute, recomputed from the ballot so the TV
// updates as votes land (the frozen count on reviewCurrent is only set at tally).
function reviewCounts(room) {
  const rc = room.reviewCurrent;
  if (!rc) return { yes: 0, no: 0, voted: 0 };
  let yes = 0, no = 0;
  for (const id of reviewerIdsFor(room, rc.playerId)) {
    const v = room.reviewVotes[id];
    if (v === 'yes') yes++; else if (v === 'no') no++;
  }
  return { yes, no, voted: yes + no };
}

// A wrongly-judged player taps "Request Review" while the truth is on screen.
// Queued (deduped) for the REVIEW phase after the reveal finishes.
function requestReview(io, room, playerId) {
  if (room.state !== STATES.REVEAL) return false;
  if (!room.settings.allowReviews || !room.truthRevealed) return false;
  if (connectedHumans(room).length < 2) return false;   // need another human to judge it
  const p = room.players.find((x) => x.id === playerId);
  if (!p || !p.connected || p.isBot) return false;
  const a = room.answers[playerId];
  if (!a || !a.judged || a.correct) return false;   // only an answered, judged-WRONG player
  if (!room.reviewRequests.includes(playerId)) room.reviewRequests.push(playerId);
  touch(room);
  broadcast(io, room.code);
  return true;
}

// End of REVEAL: run the disputes if any were requested and there's a table to
// judge them; otherwise straight to scoring.
function afterReveal(io, room) {
  const wantReviews = room.settings.allowReviews
    && room.reviewRequests.length > 0
    && connectedHumans(room).length >= 2;
  if (wantReviews) beginReviews(io, room);
  else beginScoring(io, room);
}

function beginReviews(io, room) {
  clearTimer(room);
  // Validate + de-dupe the queued requests: still a connected player whose
  // answer was judged wrong (a reconnect or a late judgement could change this).
  const seen = new Set();
  room.reviewQueue = room.reviewRequests.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const p = room.players.find((x) => x.id === id);
    const a = room.answers[id];
    return p && p.connected && a && a.judged && !a.correct;
  });
  room.reviewRequests = [];
  nextReview(io, room);
}

function nextReview(io, room) {
  clearTimer(room);
  room.reviewCurrent = null;
  room.reviewVotes = {};
  // Advance to the next dispute that still has at least one eligible judge.
  while (room.reviewQueue.length) {
    const id = room.reviewQueue.shift();
    const p = room.players.find((x) => x.id === id);
    const a = room.answers[id];
    const reviewers = reviewerIdsFor(room, id);
    if (!p || !a || !reviewers.length) continue;   // nobody left to judge → skip it
    room.reviewCurrent = {
      playerId: id,
      name: p.name,
      piece: p.piece,
      answerText: a.text,
      truth: room.question ? room.question.answer : '',
      resolved: false,
      passed: false,
      yes: 0,
      no: 0,
      voterCount: reviewers.length
    };
    room.reviewVotes = {};
    room.state = STATES.REVIEW;
    touch(room);
    broadcast(io, room.code);
    setTimer(room, room.botMode ? 1 : REVIEW_SECONDS * 1000, () => tallyReview(io, room));
    return;
  }
  // Queue drained — resume the normal flow.
  beginScoring(io, room);
}

function castReviewVote(io, room, playerId, vote) {
  if (room.state !== STATES.REVIEW) return false;
  const rc = room.reviewCurrent;
  if (!rc || rc.resolved) return false;
  if (playerId === rc.playerId) return false;                       // the disputer can't judge
  const p = room.players.find((x) => x.id === playerId);
  if (!p || !p.connected || p.isBot) return false;                  // humans only judge reviews
  if (!reviewerIdsFor(room, rc.playerId).includes(playerId)) return false;
  const v = vote === 'yes' ? 'yes' : vote === 'no' ? 'no' : null;
  if (!v) return false;
  room.reviewVotes[playerId] = v;                                   // re-votes replace
  touch(room);
  broadcast(io, room.code);
  // Once every reviewer has weighed in, tally after a short beat.
  const reviewers = reviewerIdsFor(room, rc.playerId);
  if (reviewers.every((id) => room.reviewVotes[id])) {
    setTimer(room, LAST_DING_BEAT_MS, () => tallyReview(io, room));
  }
  return true;
}

function tallyReview(io, room) {
  clearTimer(room);
  const rc = room.reviewCurrent;
  if (!rc) { nextReview(io, room); return; }
  const { yes, no } = reviewCounts(room);
  const passed = yes > no;                                          // a tie is denied
  rc.yes = yes; rc.no = no; rc.resolved = true; rc.passed = passed;
  if (passed) applyReviewPass(room, rc.playerId);
  touch(room);
  broadcast(io, room.code);
  setTimer(room, room.botMode ? 1 : REVIEW_RESULT_MS, () => nextReview(io, room));
}

// A passed review promotes the player to "correct" and patches JUST their row of
// lastResults (a full recompute would double-consume the coffee-cup bonus and
// re-run everyone). Their votes-pulled / found-truth stay as computed; only the
// knowing-it points are added, then spaces are re-summed so SCORING moves them.
function applyReviewPass(room, playerId) {
  const r = room.lastResults[playerId];
  const p = room.players.find((x) => x.id === playerId);
  if (!r || !p || r.correct) return;
  const s = room.settings;
  r.correct = true;
  r.reviewed = true;
  let gain = s.pointsCorrectAnswer;
  if (p.doubleNext) { gain *= s.bonusTileMultiplier; r.doubled = true; p.doubleNext = false; }
  r.fromAnswer = gain;
  r.spaces = Math.max(0, r.fromAnswer + r.fromVotes + r.fromTruth);
  if (room.answers[playerId]) room.answers[playerId].correct = true;
  // Running tallies so the leaderboard + streaks count the overturned answer.
  p.correct += 1;
  p.streak += 1;
  if (p.streak > p.bestStreak) p.bestStreak = p.streak;
  r.streak = p.streak;
}

// Work out every player's spaces for the round. Positions are NOT touched here
// — that happens in SCORING so the results card can land before anything moves.
function computeResults(room) {
  const s = room.settings;
  const results = {};
  for (const p of room.players) {
    results[p.id] = {
      answered: !!room.answers[p.id],
      answerText: room.answers[p.id] ? room.answers[p.id].text : null,
      correct: !!(room.answers[p.id] && room.answers[p.id].correct),
      judgedBy: room.answers[p.id] ? room.answers[p.id].tier : null,
      fromAnswer: 0,
      fromVotes: 0,
      fromTruth: 0,
      votesPulled: 0,
      doubled: false,
      duel: null,
      spaces: 0
    };
  }

  // 1. Knowing the answer.
  for (const p of room.players) {
    const r = results[p.id];
    if (!r.correct) continue;
    let gain = s.pointsCorrectAnswer;
    if (p.doubleNext) {
      gain *= s.bonusTileMultiplier;
      r.doubled = true;
      p.doubleNext = false;   // the coffee-cup tile is consumed
    }
    r.fromAnswer = gain;
  }

  // 2. Votes pulled by each ballot entry, credited to its author(s). Shared
  //    entries split the credit exactly: floor for everyone, then hand out the
  //    remainder one at a time so the total never inflates.
  for (const b of room.ballot) {
    const voters = votersFor(room, b.letter);
    if (!voters.length) continue;
    if (b.isTruth) {
      // Finding the truth pays the voter, not an author.
      for (const voterId of voters) {
        if (results[voterId]) results[voterId].fromTruth += s.pointsFoundTruth;
      }
      continue;
    }
    if (!b.authorIds.length) continue;  // a house decoy fooled someone; nobody banks it
    const total = voters.length * s.pointsPerVote;
    const each = Math.floor(total / b.authorIds.length);
    let remainder = total - each * b.authorIds.length;
    for (const authorId of b.authorIds) {
      if (!results[authorId]) continue;
      let share = each;
      if (remainder > 0) { share += 1; remainder -= 1; }
      results[authorId].fromVotes += share;
      results[authorId].votesPulled += voters.length;
    }
  }

  // 3. Optional consolation when the whole table missed the truth.
  if (s.pointsNobodyFoundTruth > 0) {
    const truth = room.ballot.find((b) => b.isTruth);
    const foundIt = truth ? votersFor(room, truth.letter).length : 0;
    if (!foundIt) {
      for (const id of correctPlayerIds(room)) {
        if (results[id]) results[id].fromAnswer += s.pointsNobodyFoundTruth;
      }
    }
  }

  for (const p of room.players) {
    const r = results[p.id];
    r.spaces = r.fromAnswer + r.fromVotes + r.fromTruth;
  }

  // 4. Duel: only the two named players, decided on this round's totals. The
  //    winner takes DUEL_STAKE spaces off the loser on top of their own gains.
  if (room.duelPending) {
    const { challengerId, opponentId } = room.duelPending;
    const a = results[challengerId];
    const b = results[opponentId];
    if (a && b) {
      const DUEL_STAKE = 2;
      if (a.spaces !== b.spaces) {
        const winnerId = a.spaces > b.spaces ? challengerId : opponentId;
        const loserId = winnerId === challengerId ? opponentId : challengerId;
        results[winnerId].duel = 'won';
        results[loserId].duel = 'lost';
        // The duel is upside-only: the winner gains, the loser simply doesn't.
        // Nothing in this game takes spaces away.
        results[winnerId].spaces += DUEL_STAKE;
      } else {
        a.duel = 'draw';
        b.duel = 'draw';
      }
    }
  }

  // A round can never be worth negative spaces. Belt and braces: nothing above
  // subtracts today, but a future mechanic shouldn't be able to sneak a
  // backward move in either.
  for (const p of room.players) {
    if (results[p.id].spaces < 0) results[p.id].spaces = 0;
  }

  // Per-player running tallies (stats + TV flair).
  for (const p of room.players) {
    const r = results[p.id];
    if (r.correct) {
      p.correct += 1;
      p.streak += 1;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
    } else {
      p.streak = 0;
    }
    p.fooled += r.votesPulled;
    r.streak = p.streak;
  }

  room.lastResults = results;
}

// Feed the round's outcome back into the question bank so the admin page can
// show which questions play too easy or too hard.
function recordQuestionStats(room) {
  if (!room.question || room.botMode) return;
  const answered = Object.keys(room.answers).length;
  const correct = correctPlayerIds(room).length;
  const wrongAnswers = room.players
    .filter((p) => room.answers[p.id] && !room.answers[p.id].correct)
    .map((p) => room.answers[p.id].text);
  try { Questions.recordPlay(room.question.id, { answered, correct, wrongAnswers }); }
  catch (e) { console.warn('[questions] stat record failed:', e.message); }
}

// Read-only: how many pieces will land on an arrow tile this round. Mirrors
// the landing check in applyMovement WITHOUT mutating anything, because
// scoringMs runs before applyMovement (positions apply only after the lead) and
// still needs to budget the extra arrow-hop time up front.
function advanceCountFor(room) {
  const finish = room.settings.boardSpaces;
  let count = 0;
  for (const p of room.players) {
    const r = room.lastResults[p.id];
    if (!r) continue;
    const move = r.spaces || 0;
    if (move === 0) continue;
    const pos = Math.max(0, Math.min(p.position + move, finish));
    if (Board.spaceAt(room.board, pos).type === Board.TYPES.ADVANCE) count++;
  }
  return count;
}

function scoringMs(room) {
  if (room.botMode) return SIM.SCORING_MS;
  const n = room.players.filter((p) => p.connected).length;
  const adv = advanceCountFor(room);
  return SCORING_VIEW_MS + SLIDE_LEAD_MS + Math.max(0, n - 1) * SLIDE_STAGGER_MS + SLIDE_MS
    + adv * ADVANCE_EXTRA_MS;
}

function applyMovement(io, room) {
  room.lastSlides = {};
  room.duelPick = null;
  const finish = room.settings.boardSpaces;
  const duelLanders = [];

  for (const p of room.players) {
    const r = room.lastResults[p.id];
    if (!r) continue;
    const move = r.spaces || 0;
    if (move === 0) continue;

    const before = p.position;
    let pos = Math.max(0, Math.min(p.position + move, finish));
    const landed = Board.spaceAt(room.board, pos);

    if (landed.type === Board.TYPES.ADVANCE) {
      // The painted arrows point along the direction of travel: landing on one
      // nudges you a square or two further on. Relative steps, not a jump to a
      // fixed square, and the nudge never chains into whatever it lands on.
      const from = pos;
      pos = Math.min(pos + (landed.steps || 1), finish);
      room.lastSlides[p.id] = { from, to: pos, dir: 'forward' };
      r.advanced = pos - from;
      r.advancedFrom = from;
      r.advancedTo = pos;
    } else if (landed.type === Board.TYPES.BONUS) {
      p.doubleNext = true;               // next correct answer pays double
      r.landedBonus = true;
    } else if (landed.type === Board.TYPES.DUEL) {
      duelLanders.push(p.id);
      r.landedDuel = true;
    }
    p.position = pos;
    // One line per move, with its cause. A board game that silently teleports
    // a piece is impossible to diagnose from a bug report after the fact.
    console.log('[move] ' + p.name + ' ' + before + ' +' + move + ' -> ' + Math.min(before + move, finish) +
      (r.advanced ? ' -> arrow +' + r.advanced + ' -> ' + pos : '') +
      ' = ' + pos + (pos < before ? '  (NET BACKWARD ' + (pos - before) + ')' : ''));
  }

  // Whoever landed on a duel tile owes us an opponent choice, collected during
  // the next ROUND_INTRO. Two landers simply face each other.
  if (duelLanders.length >= 2) {
    room.duelPick = { playerId: duelLanders[0], opponentId: duelLanders[1] };
  } else if (duelLanders.length === 1) {
    room.duelPick = { playerId: duelLanders[0], opponentId: null };
  }
}

function beginScoring(io, room) {
  clearTimer(room);
  const total = scoringMs(room);
  room.state = STATES.SCORING;
  touch(room);

  if (room.botMode) {
    applyMovement(io, room);
    setTimer(room, total, () => endScoring(io, room));
    broadcast(io, room.code);
    return;
  }
  // The results card lands with every piece frozen; positions apply only after
  // the lead so the board is clear before anything slides.
  broadcast(io, room.code);
  setTimer(room, SLIDE_LEAD_MS, () => {
    applyMovement(io, room);
    touch(room);
    broadcast(io, room.code);
    setTimer(room, Math.max(0, total - SLIDE_LEAD_MS), () => endScoring(io, room));
  });
}

function endScoring(io, room) {
  const finish = room.settings.boardSpaces;
  const arrived = room.players.filter((p) => p.position >= finish);
  if (arrived.length) {
    // Clinch mode: standing on the couch only counts if you scored this round.
    // Anyone else waits on the line and tries again next round.
    const eligible = room.settings.finalRoundToClinch
      ? arrived.filter((p) => ((room.lastResults[p.id] || {}).spaces || 0) > 0)
      : arrived;
    // Two or more claimants: they play for it. A disconnected piece can't answer
    // a sudden-death question, so it isn't a finalist — if that leaves exactly
    // one live claimant, they simply take the game.
    const finalists = eligible.filter((p) => p.connected);
    if (finalists.length >= 2) { beginFaceOff(io, room, finalists.map((p) => p.id)); return; }
    if (finalists.length === 1) { beginGameOver(io, room, { winnerId: finalists[0].id }); return; }
    if (eligible.length) {
      // Only disconnected arrivals. Nobody is here to play a face-off, so fall
      // back to the deterministic tiebreak: this round's spaces, then correct count.
      const winner = eligible.sort((a, b) =>
        ((room.lastResults[b.id] || {}).spaces || 0) - ((room.lastResults[a.id] || {}).spaces || 0) ||
        b.correct - a.correct)[0];
      beginGameOver(io, room, { winnerId: winner.id });
      return;
    }
  }
  beginRoundIntro(io, room);
}

// ─── couch face-off ───
//
// Two pieces reaching the couch in the same round used to be settled by a sort:
// most spaces this round, then most correct answers. Nobody at the table could
// see that happen — the game simply ended and named someone. (Clinch mode was
// worse: it took the first match in player order, so a simultaneous clinch went
// to whoever joined the room earliest.) Now they play for it.
//
// Sudden death, finalists only: one question, no bluffing, no voting. The
// FASTEST CORRECT answer takes the game — submission time is already recorded on
// every answer, so ranking by it is free. Nobody right, next question.
//
// Everyone else is a spectator. Their pieces stay where they finished; the
// face-off decides the winner, not the standings.
function beginFaceOff(io, room, finalistIds) {
  clearTimer(room);
  clearBotTimers(room);
  room.state = STATES.FACE_OFF;
  room.faceOff = {
    playerIds: finalistIds.slice(),
    phase: 'intro',      // 'intro' -> 'answer' -> 'result' -> (answer | GAME_OVER)
    leg: 0,              // sudden-death questions played so far
    answers: {},         // playerId -> { text, ms, correct, tier, judged }
    openedAt: 0,
    pending: 0,          // in-flight judgements, same guard as ANSWERING
    result: null
  };
  touch(room);
  console.log('[faceoff] on the couch: ' + finalistIds
    .map((id) => (room.players.find((p) => p.id === id) || {}).name).join(' vs '));
  setTimer(room, room.botMode ? 600 : FACE_OFF_INTRO_MS, () => beginFaceOffLeg(io, room));
  broadcast(io, room.code);
}

function faceOffFinalists(room) {
  if (!room.faceOff) return [];
  return room.faceOff.playerIds
    .map((id) => room.players.find((p) => p.id === id))
    .filter(Boolean);
}

function beginFaceOffLeg(io, room) {
  const fo = room.faceOff;
  if (room.state !== STATES.FACE_OFF || !fo) return;
  clearTimer(room);

  const q = dealQuestion(room);
  if (!q) { resolveFaceOffFallback(io, room, 'out-of-questions'); return; }
  room.question = q;
  room.usedQuestions.add(q.id);
  for (const p of room.players) {
    if (p.userId && onQuestionServed) {
      try { onQuestionServed(p.userId, q.id); } catch (e) {}
    }
  }

  fo.leg += 1;
  fo.phase = 'answer';
  fo.answers = {};
  fo.result = null;
  fo.pending = 0;
  fo.openedAt = Date.now();
  room.judgeBudget = Judge.newRoundBudget();
  touch(room);
  const secs = Math.min(room.settings.answerSeconds, FACE_OFF_ANSWER_CAP_S);
  setTimer(room, room.botMode ? SIM.ANSWER_MS : secs * 1000, () => closeFaceOffLeg(io, room));
  broadcast(io, room.code);
  scheduleBotFaceOff(io, room);
}

// A finalist's sudden-death answer. Judged on arrival like any other, but the
// verdict is NOT returned on the ack the way a normal answer's is — with two
// people racing, telling one of them "correct" while the other is still typing
// throws away the only moment this phase exists for. Everyone finds out together
// on the result card.
async function submitFaceOffAnswer(io, room, playerId, text) {
  const fo = room.faceOff;
  if (room.state !== STATES.FACE_OFF || !fo || fo.phase !== 'answer') {
    return { ok: false, error: 'Not accepting answers' };
  }
  if (!fo.playerIds.includes(playerId)) return { ok: false, error: 'Only the players on the couch answer' };
  if (fo.answers[playerId]) return { ok: false, error: 'You already answered' };
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) return { ok: false, error: 'Type your answer.' };

  const entry = { text: clean, ms: Date.now() - fo.openedAt, correct: false, tier: 0, judged: false };
  fo.answers[playerId] = entry;
  fo.pending += 1;
  touch(room);
  broadcast(io, room.code);

  let verdict = { correct: false, tier: 2 };
  try {
    verdict = await Judge.judgeAnswer(clean, room.question, room.judgeBudget);
  } catch (e) {
    console.error('[faceoff] judge threw, treating as wrong:', e.message);
  }
  entry.correct = !!verdict.correct;
  entry.tier = verdict.tier;
  entry.judged = true;
  fo.pending = Math.max(0, fo.pending - 1);

  if (room.state === STATES.FACE_OFF && fo.phase === 'answer') {
    broadcast(io, room.code);
    const live = faceOffFinalists(room).filter((p) => p.connected);
    if (live.length && live.every((p) => fo.answers[p.id] && fo.answers[p.id].judged)) {
      setTimer(room, LAST_DING_BEAT_MS, () => closeFaceOffLeg(io, room));
    }
  }
  return { ok: true };
}

function closeFaceOffLeg(io, room, waited = 0) {
  const fo = room.faceOff;
  if (room.state !== STATES.FACE_OFF || !fo || fo.phase !== 'answer') return;
  // Same grace as ANSWERING, and it matters more here: resolving on a tier-2
  // verdict while the AI judge is still in flight would hand somebody the GAME.
  if (fo.pending > 0 && waited < JUDGE_GRACE_MS) {
    setTimer(room, 250, () => closeFaceOffLeg(io, room, waited + 250));
    return;
  }
  if (fo.pending > 0) {
    console.warn('[faceoff] ' + fo.pending + ' judgement(s) pending after grace — using tier-2 verdicts');
    fo.pending = 0;
  }
  clearTimer(room);

  const rows = faceOffFinalists(room).map((p) => {
    const a = fo.answers[p.id];
    return {
      playerId: p.id,
      text: a ? a.text : null,
      correct: !!(a && a.correct),
      ms: a ? a.ms : null
    };
  });
  // Fastest correct answer wins. Nobody correct -> winnerId stays null and the
  // room goes again on a fresh question.
  const winners = rows.filter((r) => r.correct).sort((a, b) => a.ms - b.ms);
  const winnerId = winners.length ? winners[0].playerId : null;

  fo.phase = 'result';
  fo.result = {
    leg: fo.leg,
    question: room.question.question,
    truth: room.question.answer,
    rows,
    winnerId,
    again: !winnerId && fo.leg < FACE_OFF_MAX_LEGS
  };
  touch(room);
  console.log('[faceoff] leg ' + fo.leg + ': ' + (winnerId
    ? (room.players.find((p) => p.id === winnerId) || {}).name + ' takes it in ' +
      Math.round((winners[0].ms || 0) / 100) / 10 + 's'
    : 'nobody got it'));
  broadcast(io, room.code);

  setTimer(room, room.botMode ? 900 : FACE_OFF_RESULT_MS, () => {
    if (room.state !== STATES.FACE_OFF) return;
    if (winnerId) { beginGameOver(io, room, { winnerId }); return; }
    if (fo.leg < FACE_OFF_MAX_LEGS) { beginFaceOffLeg(io, room); return; }
    resolveFaceOffFallback(io, room, 'face-off-exhausted');
  });
}

// The bank ran dry mid-face-off, or five questions went by with nobody right.
// Fall back to season-long form rather than leaving the room stuck on the couch.
function resolveFaceOffFallback(io, room, reason) {
  const best = faceOffFinalists(room)
    .slice()
    .sort((a, b) => b.correct - a.correct || b.fooled - a.fooled)[0];
  console.warn('[faceoff] unresolved (' + reason + ') — falling back to season stats');
  beginGameOver(io, room, { winnerId: best ? best.id : null, reason });
}

let onGameOver = null;
function setOnGameOver(fn) { onGameOver = typeof fn === 'function' ? fn : null; }

function beginGameOver(io, room, { winnerId = null, reason = null } = {}) {
  clearTimer(room);
  let id = winnerId;
  if (!id) {
    const best = [...room.players].sort((a, b) => b.position - a.position || b.correct - a.correct)[0];
    id = best ? best.id : null;
  }
  room.winnerId = id;
  room.endReason = reason;
  room.state = STATES.GAME_OVER;
  touch(room);
  broadcast(io, room.code);
  if (onGameOver) {
    try { onGameOver(room, { winnerId: room.winnerId }); }
    catch (e) { console.error('[profiles] onGameOver hook failed:', e); }
  }
}

function returnToLobby(io, room) {
  clearTimer(room);
  clearBotTimers(room);
  room.state = STATES.LOBBY;
  room.round = 0;
  room.question = null;
  room.answers = {};
  room.bluffs = {};
  room.ballot = [];
  room.votes = {};
  room.laughs = {};
  room.lastResults = {};
  room.lastSlides = {};
  room.reviewRequests = [];
  room.reviewQueue = [];
  room.reviewCurrent = null;
  room.reviewVotes = {};
  room.duelPending = null;
  room.duelPick = null;
  room.faceOff = null;
  room.winnerId = null;
  room.players.forEach((p) => {
    p.position = 0;
    p.correct = 0;
    p.fooled = 0;
    p.streak = 0;
    p.bestStreak = 0;
    p.doubleNext = false;
  });
  room.lastBotState = null;
  room.paused = false;
  room.pausedRemainingMs = null;
  room.pausedTimerFn = null;
  touch(room);
  broadcast(io, room.code);
}

// ─── action dispatcher ───
function handle(io, { socket, role, roomCode, playerId, action, data }) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  touch(room);

  switch (action) {
    case 'updateSettings': {
      if (room.state !== STATES.LOBBY) return false;
      const before = room.settings.boardSpaces;
      room.settings = sanitizeSettings(data, room.settings);
      // Rebuild the board only if the length actually changed.
      if (room.settings.boardSpaces !== before) room.board = Board.buildBoard(room.settings.boardSpaces);
      broadcast(io, room.code);
      return true;
    }
    case 'startGame': { startGame(io, room); return true; }
    case 'pauseGame': return pauseGame(io, room);
    case 'resumeGame': return resumeGame(io, room);
    case 'submitAnswer': {
      if (role !== 'player') return false;
      // Async: the dispatcher in index.js awaits the promise for the ack.
      return submitAnswer(io, room, playerId, data && data.text);
    }
    case 'submitBluff': {
      if (role !== 'player') return false;
      return submitBluff(io, room, playerId, data && data.text);
    }
    case 'rescueAnswer': {
      if (role !== 'player') return false;
      // Async: may call out to the model before it can answer.
      return rescueAnswer(io, room, playerId);
    }
    case 'randomBluff': {
      if (role !== 'player') return false;
      if (!bluffWindowOpen(room, playerId)) return { ok: false, error: 'Not accepting lies' };
      const text = randomBluff(room, playerId);
      if (!text) return { ok: false, error: 'No spare lies left — write your own.' };
      return { ok: true, text };
    }
    case 'submitFaceOffAnswer': {
      if (role !== 'player') return false;
      // Async: the dispatcher in index.js awaits the promise for the ack.
      return submitFaceOffAnswer(io, room, playerId, data && data.text);
    }
    case 'vote': {
      if (role !== 'player') return false;
      return castVote(io, room, playerId, data && data.letter);
    }
    case 'laughReact': {
      if (role !== 'player') return false;
      return toggleLaugh(io, room, playerId, data && data.letter);
    }
    case 'requestReview': {
      if (role !== 'player') return false;
      return requestReview(io, room, playerId);
    }
    case 'castReviewVote': {
      if (role !== 'player') return false;
      return castReviewVote(io, room, playerId, data && data.vote);
    }
    case 'pickDuelOpponent': {
      if (role !== 'player') return false;
      if (!room.duelPick || room.duelPick.playerId !== playerId) return false;
      const target = room.players.find((p) => p.id === (data && data.opponentId) && p.id !== playerId);
      if (!target) return false;
      room.duelPick.opponentId = target.id;
      broadcast(io, room.code);
      return true;
    }
    case 'skipPhase': {
      switch (room.state) {
        case STATES.ROUND_INTRO: beginAnswering(io, room); return true;
        case STATES.ANSWERING: closeAnswering(io, room, JUDGE_GRACE_MS); return true;
        case STATES.BLUFFING: beginVoting(io, room); return true;
        case STATES.VOTING: beginReveal(io, room); return true;
        case STATES.REVEAL: { clearTimer(room); afterReveal(io, room); return true; }
        case STATES.REVIEW: { clearTimer(room); tallyReview(io, room); return true; }
        case STATES.SCORING: {
          clearTimer(room);
          applyMovement(io, room);
          endScoring(io, room);
          return true;
        }
        // Skips one sub-phase of the face-off, not the whole thing — a host
        // shouldn't be able to jump past the question that decides the game.
        case STATES.FACE_OFF: {
          const fo = room.faceOff;
          if (!fo) return false;
          if (fo.phase === 'intro') { beginFaceOffLeg(io, room); return true; }
          if (fo.phase === 'answer') { closeFaceOffLeg(io, room, JUDGE_GRACE_MS); return true; }
          clearTimer(room);
          if (fo.result && fo.result.winnerId) { beginGameOver(io, room, { winnerId: fo.result.winnerId }); return true; }
          if (fo.leg < FACE_OFF_MAX_LEGS) { beginFaceOffLeg(io, room); return true; }
          resolveFaceOffFallback(io, room, 'face-off-exhausted');
          return true;
        }
        default: return false;
      }
    }
    case 'playAgain': {
      if (room.state !== STATES.GAME_OVER) return false;
      startGame(io, room);
      return true;
    }
    case 'returnToLobby': {
      if (room.state !== STATES.GAME_OVER) return false;
      returnToLobby(io, room);
      return true;
    }
    case 'abortToLobby': {
      if (room.state === STATES.LOBBY) return false;
      returnToLobby(io, room);
      return true;
    }
    case 'addBot': {
      if (room.state !== STATES.LOBBY) return false;
      if (room.players.length >= MAX_PLAYERS) return false;
      const botCount = room.players.filter((p) => p.isBot).length;
      if (botCount >= MAX_BOTS) return false;
      const takenNames = new Set(room.players.map((p) => p.name.toLowerCase()));
      const takenPieces = new Set(room.players.map((p) => p.piece));
      const available = BOT_NAMES.filter((n) => !takenNames.has(n.toLowerCase()));
      const name = available.length ? available[Math.floor(Math.random() * available.length)] : ('CPU ' + (botCount + 1));
      const piece = ALL_PIECES.find((pp) => !takenPieces.has(pp));
      if (!piece) return false;
      const id = newPlayerId();
      room.players.push({
        id, socketId: 'bot-' + id, name, piece,
        position: 0, correct: 0, fooled: 0, streak: 0, bestStreak: 0,
        doubleNext: false, connected: true, isBot: true
      });
      room.lastBotState = null;
      touch(room);
      broadcast(io, room.code);
      return true;
    }
    case 'removeBot': {
      if (room.state !== STATES.LOBBY) return false;
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].isBot) {
          room.players.splice(i, 1);
          touch(room);
          broadcast(io, room.code);
          return true;
        }
      }
      return false;
    }
    default: return false;
  }
}

function handleDisconnect(io, socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  if (socket.data.role === 'tv') { room.tvSocketIds.delete(socket.id); return; }
  if (socket.data.role === 'player') {
    const p = room.players.find((x) => x.id === socket.data.playerId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    // The round may now be waiting on nobody — nudge it along.
    if (room.state === STATES.ANSWERING) {
      const expected = room.players.filter((x) => x.connected);
      if (expected.length && expected.every((x) => room.answers[x.id] && room.answers[x.id].judged)) {
        setTimer(room, LAST_DING_BEAT_MS, () => closeAnswering(io, room));
      }
    } else if (room.state === STATES.VOTING) {
      const voters = room.players.filter((x) => x.connected && !(room.answers[x.id] && room.answers[x.id].correct));
      if (voters.length && voters.every((x) => room.votes[x.id])) {
        setTimer(room, LAST_DING_BEAT_MS, () => beginReveal(io, room));
      }
    } else if (room.state === STATES.FACE_OFF && room.faceOff && room.faceOff.phase === 'answer') {
      // Don't sit out the clock waiting on a finalist who just left. Their
      // missing answer simply counts as wrong when the leg resolves.
      const live = faceOffFinalists(room).filter((x) => x.connected);
      if (live.length && live.every((x) => room.faceOff.answers[x.id] && room.faceOff.answers[x.id].judged)) {
        setTimer(room, LAST_DING_BEAT_MS, () => closeFaceOffLeg(io, room));
      }
    }
    broadcast(io, room.code);
  }
}

function evictIdleRooms(io) {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivityAt > ROOM_IDLE_MS) {
      clearTimer(room);
      clearBotTimers(room);
      io.to(code).emit('roomClosed', { reason: 'idle' });
      rooms.delete(code);
    }
  }
}

// ─── broadcast: per-role snapshots ───
//
// NOBODY receives which ballot entry is the real answer before REVEAL — not
// the TV, not even the players who answered correctly (they know it, but the
// payload must not confirm it, or a peek at devtools becomes a cheat).

function broadcast(io, code) {
  const room = rooms.get(code);
  if (!room) return;
  const tvSnap = tvSnapshot(room);
  for (const tvSocketId of room.tvSocketIds) io.to(tvSocketId).emit('state', tvSnap);
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', playerSnapshot(room, p.id));
  }
  const hasBots = room.players.some((p) => p.isBot);
  if (hasBots && room.state !== room.lastBotState) {
    room.lastBotState = room.state;
    scheduleBotActions(io, room);
  }
}

function revealed(state) {
  return state === STATES.REVEAL || state === STATES.REVIEW
    || state === STATES.SCORING || state === STATES.GAME_OVER;
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, piece: p.piece,
    position: p.position, correct: p.correct, fooled: p.fooled,
    streak: p.streak, bestStreak: p.bestStreak,
    doubleNext: !!p.doubleNext,
    connected: p.connected, isBot: !!p.isBot
  };
}

// The ballot as clients may see it. `isTruth` is stripped until REVEAL.
function publicBallot(room, withTruth) {
  return room.ballot.map((b) => {
    const out = { letter: b.letter, text: b.text };
    if (withTruth) {
      out.isTruth = b.isTruth;
      out.isDecoy = b.isDecoy;
      out.authorIds = b.authorIds;
      out.voters = votersFor(room, b.letter);
      out.laughers = (room.laughs[b.letter] || []).slice();   // who 😂'd this entry
    }
    return out;
  });
}

function baseSnapshot(room) {
  const answeredIds = Object.keys(room.answers);
  return {
    code: room.code,
    state: room.state,
    paused: !!room.paused,
    settings: room.settings,
    // Every category in the bank, so the lobby can render its toggles
    // without a second round trip.
    allCategories: Questions.categories(),
    board: room.board,
    players: room.players.map(publicPlayer),
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    // The question TEXT is public from ROUND_INTRO on; the answer never is.
    question: room.question && room.state !== STATES.LOBBY ? {
      id: room.question.id,
      category: room.question.category,
      difficulty: room.question.difficulty,
      question: room.question.question
    } : null,
    answeredPlayerIds: answeredIds,
    // Counts only — never who got it right, until REVEAL.
    correctCount: revealed(room.state) || room.state === STATES.BLUFFING || room.state === STATES.VOTING
      ? correctPlayerIds(room).length : 0,
    // Withheld during ANSWERING: correct players start their lie early, so a
    // non-empty list in that phase would name exactly who got it right while
    // the rest of the room is still typing.
    bluffedPlayerIds: room.state === STATES.ANSWERING ? [] : Object.keys(room.bluffs),
    // Who got laughed WITH this round (author -> 😂 count), shown at the reveal.
    laughLeaders: revealed(room.state) ? laughLeaders(room) : [],
    // During BLUFFING, WHO is writing lies (the players who got it right) so the
    // TV can show a check-in strip of just the writers. Only exposed in this
    // phase — outside it, revealing the correct players would leak the ballot.
    bluffingPlayerIds: room.state === STATES.BLUFFING ? correctPlayerIds(room) : [],
    votedPlayerIds: Object.keys(room.votes),
    // During VOTING, WHO gets to vote (the players who missed it) so the TV can
    // show a check-in strip of just the voters. Only exposed in this phase.
    votingPlayerIds: room.state === STATES.VOTING
      ? room.players.filter((p) => p.connected && !(room.answers[p.id] && room.answers[p.id].correct)).map((p) => p.id)
      : [],
    ballot: (room.state === STATES.VOTING || revealed(room.state)) ? publicBallot(room, revealed(room.state)) : [],
    revealIndex: room.revealIndex,
    revealOrder: revealed(room.state) ? room.revealOrder : [],
    truth: revealed(room.state) && room.question ? room.question.answer : null,
    lastResults: revealed(room.state) ? room.lastResults : {},
    lastSlides: room.lastSlides || {},
    // Why a phase was skipped this round ('everyone-knew' | 'nobody-knew'),
    // so the UI can explain it instead of appearing to swallow a turn.
    skipReason: room.skipReason || null,
    // Answer review. `reviewsOpen` = a wrongly-judged player may dispute right
    // now (during REVEAL, once the truth is up). `review` = the dispute the
    // table is judging during REVIEW, with a live yes/no tally.
    reviewsOpen: !!(room.settings.allowReviews && room.state === STATES.REVEAL
      && room.truthRevealed && connectedHumans(room).length >= 2),
    review: reviewView(room),
    duel: room.duelPending || null,
    duelPick: room.duelPick || null,
    faceOff: faceOffView(room),
    winnerId: room.winnerId || null
  };
}

// The face-off as everyone (TV included) may see it. During the answer phase
// only WHO has locked in is public — never a verdict and never the truth. Both
// arrive together on the result card, which is the whole point of the phase.
function faceOffView(room) {
  const fo = room.faceOff;
  if (room.state !== STATES.FACE_OFF || !fo) return null;
  return {
    phase: fo.phase,
    leg: fo.leg,
    maxLegs: FACE_OFF_MAX_LEGS,
    playerIds: fo.playerIds.slice(),
    answeredPlayerIds: Object.keys(fo.answers),
    result: fo.phase === 'result' ? fo.result : null
  };
}

// The current dispute as everyone (TV included) may see it — no ballot secrets,
// just the disputed answer, the truth, and the running tally.
function reviewView(room) {
  if (room.state !== STATES.REVIEW || !room.reviewCurrent) return null;
  const rc = room.reviewCurrent;
  const { yes, no, voted } = reviewCounts(room);
  return {
    name: rc.name,
    piece: rc.piece,
    answerText: rc.answerText,
    truth: rc.truth,
    yes, no, voted,
    voterCount: rc.voterCount,
    resolved: rc.resolved,
    passed: rc.passed,
    remaining: room.reviewQueue.length   // disputes still queued behind this one
  };
}

function tvSnapshot(room) {
  const base = baseSnapshot(room);
  base.role = 'tv';
  return base;
}

function playerSnapshot(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return null;
  const base = baseSnapshot(room);
  const myAnswer = room.answers[playerId] || null;
  const iWasCorrect = !!(myAnswer && myAnswer.correct);
  base.role = 'player';
  base.me = publicPlayer(p);
  base.myAnswer = myAnswer ? myAnswer.text : null;
  // A player learns their OWN verdict as soon as it's judged — that's what
  // routes them to the bluff screen vs the waiting screen.
  base.myAnswerCorrect = myAnswer && myAnswer.judged ? myAnswer.correct : null;
  base.myBluff = room.bluffs[playerId] || null;
  base.myVote = room.votes[playerId] || null;
  // Ballot letters this player reacted 😂 to, so the vote screen can highlight them.
  base.myLaughs = Object.keys(room.laughs).filter((l) => (room.laughs[l] || []).includes(playerId));
  base.myResult = revealed(room.state) ? (room.lastResults[playerId] || null) : null;
  base.canAnswer = room.state === STATES.ANSWERING && !myAnswer;
  // Rescues are private to the player who owns them. The room never learns that
  // somebody reached for one — an entry the table knows was auto-generated is an
  // entry nobody votes for, which would defeat the whole point of offering it.
  base.rescuesLeft = typeof p.rescuesLeft === 'number' ? p.rescuesLeft : RESCUES_PER_GAME;
  base.rescuesPerGame = RESCUES_PER_GAME;
  base.canBluff = bluffWindowOpen(room, playerId) && iWasCorrect && !room.bluffs[playerId];
  base.canVote = room.state === STATES.VOTING && !iWasCorrect && !room.votes[playerId];
  // Entries this player wrote, so the phone can grey them out when voting.
  base.myBallotLetters = room.ballot.filter((b) => b.authorIds.includes(playerId)).map((b) => b.letter);
  base.mustPickDuel = !!(room.duelPick && room.duelPick.playerId === playerId && !room.duelPick.opponentId);
  // Face-off: finalists get the sudden-death input, everyone else watches.
  const fo = room.faceOff;
  base.iAmFinalist = !!(fo && fo.playerIds.includes(playerId));
  base.myFaceOffAnswer = fo && fo.answers[playerId] ? fo.answers[playerId].text : null;
  base.canFaceOff = room.state === STATES.FACE_OFF && !!fo && fo.phase === 'answer'
    && base.iAmFinalist && !fo.answers[playerId];
  // Review: during REVEAL a wrongly-judged player can request one (once); during
  // REVIEW the disputer waits while the OTHER players get a yes/no ballot.
  base.iRequestedReview = room.reviewRequests.includes(playerId);
  base.canRequestReview = base.reviewsOpen
    && !!(myAnswer && myAnswer.judged && !myAnswer.correct)
    && !base.iRequestedReview;
  base.isDisputer = false;
  base.canReviewVote = false;
  base.myReviewVote = null;
  if (room.state === STATES.REVIEW && room.reviewCurrent) {
    const rc = room.reviewCurrent;
    base.isDisputer = rc.playerId === playerId;
    base.myReviewVote = room.reviewVotes[playerId] || null;
    base.canReviewVote = !base.isDisputer && !rc.resolved
      && p.connected && !p.isBot
      && reviewerIdsFor(room, rc.playerId).includes(playerId);
  }
  // Hold the phone back until the TV has revealed. Everything that could give
  // the answer away is stripped, not just the truth string — the results map
  // and the marked-up ballot would both leak it.
  base.awaitingReveal = revealed(room.state) && !room.truthRevealed;
  if (base.awaitingReveal) {
    base.truth = null;
    base.myResult = null;
    base.lastResults = {};
    base.revealOrder = [];
    base.ballot = base.ballot.map((b) => ({ letter: b.letter, text: b.text }));
  }
  base.inDuel = !!(room.duelPending &&
    (room.duelPending.challengerId === playerId || room.duelPending.opponentId === playerId));
  return base;
}

function votersFor(room, letter) {
  const out = [];
  for (const [pid, l] of Object.entries(room.votes)) if (l === letter) out.push(pid);
  return out;
}

// ─── simulation / bots ───
const BOT_NAMES = [
  'Gunther', 'Janice', 'Estelle', 'Mr. Heckles', 'Ursula', 'Emily',
  'Richard', 'Mike', 'Carol', 'Susan', 'Frank', 'Alice',
  'Charlie', 'Mona', 'Julie', 'Paolo', 'Barry', 'Mindy'
];
const ALL_PIECES = [
  'lantern', 'sasquatch', 'ufo', 'compass', 'campfire', 'mothman', 'tower', 'mushroom',
  'businessman', 'champagne', 'racer', 'soosh', 'pieguy', 'businesswoman', 'dj', 'metalmaniac', 'juicyjilz'
];
const MAX_BOTS = 4;
// How often a CPU actually knows the answer. Not 100% — a bot that never
// misses hides the wrong-answer path, which is most of this game.
const BOT_ACCURACY = 0.45;
const BOT_WRONG_GUESSES = [
  'no idea', 'something about a duck', 'it was Janice',
  'he was on a break', 'a sandwich', 'the one with the monkey',
  'Ugly Naked Guy', 'seven', 'pivot'
];

function startSimulation(io, code) {
  const room = rooms.get(code);
  if (!room) return false;
  if (room.state !== STATES.LOBBY && room.state !== STATES.GAME_OVER) return false;
  if (room.players.length > 0) return false;

  const simNames = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    const id = newPlayerId();
    room.players.push({
      id, socketId: 'bot-' + id, name: simNames[i], piece: ALL_PIECES[i],
      position: 0, correct: 0, fooled: 0, streak: 0, bestStreak: 0,
      doubleNext: false, connected: true, isBot: true
    });
  }
  // Shortest supported board, so a bot game reaches GAME_OVER quickly.
  room.settings.boardSpaces = 16;
  room.settings.allowUnverified = true;  // the starter bank is unverified
  room.board = Board.buildBoard(16);
  room.botMode = true;
  room.lastBotState = null;
  touch(room);
  startGame(io, room);
  return true;
}

// Bots race for the couch too. Scheduled directly from beginFaceOffLeg rather
// than through scheduleBotActions: that only fires on a STATE change, and every
// leg of a face-off happens inside the one FACE_OFF state.
function scheduleBotFaceOff(io, room) {
  const fo = room.faceOff;
  const q = room.question;
  if (!fo || !q || room.paused) return;
  let i = 0;
  for (const p of faceOffFinalists(room)) {
    if (!p.isBot) continue;
    const idx = i++;
    const knowsIt = Math.random() < BOT_ACCURACY;
    const text = knowsIt
      ? q.answer
      : (q.decoys && q.decoys.length
          ? q.decoys[Math.floor(Math.random() * q.decoys.length)]
          : BOT_WRONG_GUESSES[Math.floor(Math.random() * BOT_WRONG_GUESSES.length)]);
    trackedBotTimeout(room, () => {
      if (room.state !== STATES.FACE_OFF || !room.faceOff
        || room.faceOff.phase !== 'answer' || room.paused) return;
      submitFaceOffAnswer(io, room, p.id, text);
    }, room.botMode ? 400 + idx * 250 : 2000 + Math.random() * 4000);
  }
}

function scheduleBotActions(io, room) {
  if (room.paused) return;
  const q = room.question;

  if (room.state === STATES.ANSWERING) {
    if (!q) return;
    let i = 0;
    for (const p of room.players) {
      if (!p.isBot) continue;
      const idx = i++;
      // Decide up front so the delay can't leak the verdict.
      const knowsIt = Math.random() < BOT_ACCURACY;
      const text = knowsIt
        ? q.answer
        : (q.decoys && q.decoys.length && Math.random() < 0.6
            ? q.decoys[Math.floor(Math.random() * q.decoys.length)]
            : BOT_WRONG_GUESSES[Math.floor(Math.random() * BOT_WRONG_GUESSES.length)]);
      trackedBotTimeout(room, () => {
        if (room.state !== STATES.ANSWERING || room.paused) return;
        submitAnswer(io, room, p.id, text);
      }, room.botMode ? 300 + idx * 200 : 2500 + Math.random() * 4000);
    }
  } else if (room.state === STATES.BLUFFING) {
    if (!q) return;
    let i = 0;
    for (const id of correctPlayerIds(room)) {
      const p = room.players.find((x) => x.id === id);
      if (!p || !p.isBot) continue;
      const idx = i++;
      // A correct bot lies with a house decoy.
      const pool = (q.decoys || []).length ? q.decoys : BOT_WRONG_GUESSES;
      const text = pool[Math.floor(Math.random() * pool.length)];
      trackedBotTimeout(room, () => {
        if (room.state !== STATES.BLUFFING || room.paused) return;
        submitBluff(io, room, p.id, text);
      }, room.botMode ? 300 + idx * 200 : 2500 + Math.random() * 3000);
    }
  } else if (room.state === STATES.VOTING) {
    let i = 0;
    for (const id of wrongPlayerIds(room)) {
      const p = room.players.find((x) => x.id === id);
      if (!p || !p.isBot) continue;
      const idx = i++;
      const options = room.ballot.filter((b) => !b.authorIds.includes(p.id));
      if (!options.length) continue;
      const pick = options[Math.floor(Math.random() * options.length)];
      trackedBotTimeout(room, () => {
        if (room.state !== STATES.VOTING || room.paused) return;
        castVote(io, room, p.id, pick.letter);
      }, room.botMode ? 300 + idx * 200 : 3000 + Math.random() * 4000);
    }
  } else if (room.state === STATES.ROUND_INTRO) {
    // A bot that landed on a duel tile picks a rival immediately.
    if (room.duelPick && !room.duelPick.opponentId) {
      const challenger = room.players.find((x) => x.id === room.duelPick.playerId);
      if (challenger && challenger.isBot) {
        const rivals = room.players.filter((x) => x.id !== challenger.id && x.connected);
        if (rivals.length) {
          room.duelPick.opponentId = rivals[Math.floor(Math.random() * rivals.length)].id;
        }
      }
    }
  }
}

function capitalizeFirst(text) {
  if (!text) return text;
  const i = text.search(/[a-zA-Z]/);
  if (i < 0) return text;
  return text.slice(0, i) + text[i].toUpperCase() + text.slice(i + 1);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

module.exports = {
  STATES,
  roomCount,
  createRoom,
  getRoom,
  peekRoom,
  joinRoom,
  handle,
  handleDisconnect,
  broadcast,
  evictIdleRooms,
  startSimulation,
  setOnGameOver,
  setQuestionHooks,
  readDefaults,
  writeDefaults,
  settingsMeta
};
