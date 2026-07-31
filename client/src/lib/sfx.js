// Sound effects library.
//
// Everything (synthesized tones AND the .mp3 one-shots) plays through a
// single shared Web Audio AudioContext. This is deliberate: the TV screen
// is never tapped during a game (all input is on phones), so HTMLAudio
// `new Audio().play()` calls were being blocked by the browser's autoplay
// policy and silently swallowed, which is why the TV had music (a single
// long-lived element that slips through Chrome's media-engagement
// exemption) but zero sound effects. A resumed AudioContext can emit any
// buffer without a per-element user-activation gate, so once the context
// is running every effect plays on the TV the same as on a phone.

// The celebration boom is timed against the same constant the screen and the
// particle canvas use, so it can't drift off the frame the confetti fires on.
import { REVEAL } from './winnerTiming';

let _ctx = null;
let _master = null;

// Master sound volume (0..1). Persisted so a player's preference survives
// screen transitions and reloads. Applied via the master gain node once
// the context exists; held here until then.
const _STORAGE_KEY = 'cperkd_phone_volume';
let _masterVolume = 1.0;
try {
  if (typeof localStorage !== 'undefined') {
    const v = parseFloat(localStorage.getItem(_STORAGE_KEY));
    if (!isNaN(v)) _masterVolume = Math.max(0, Math.min(1, v));
  }
} catch (e) {}

const _volumeListeners = new Set();

export function setMasterVolume(v) {
  _masterVolume = Math.max(0, Math.min(1, v));
  if (_master && _ctx) {
    try { _master.gain.setValueAtTime(_masterVolume, _ctx.currentTime); }
    catch (e) { try { _master.gain.value = _masterVolume; } catch (e2) {} }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(_STORAGE_KEY, String(_masterVolume));
    }
  } catch (e) {}
  _volumeListeners.forEach((fn) => { try { fn(_masterVolume); } catch (e) {} });
}
export function getMasterVolume() { return _masterVolume; }
export function subscribeMasterVolume(fn) {
  _volumeListeners.add(fn);
  return () => _volumeListeners.delete(fn);
}

// Lazily create the shared context + master gain node. Attempts a resume
// every call: resume() is idempotent and only takes hold once the page is
// allowed audio, so any sound triggered after that point self-heals (and
// it recovers from a mobile tab-backgrounding re-suspending the context).
function ctx() {
  if (typeof window === 'undefined') return null;
  if (!_ctx) {
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
    try {
      _master = _ctx.createGain();
      _master.gain.value = _masterVolume;
      _master.connect(_ctx.destination);
    } catch (e) { _master = null; }
  }
  if (_ctx.state === 'suspended') {
    try { _ctx.resume(); } catch (e) {}
  }
  return _ctx;
}
function master() {
  const c = ctx();
  return c ? _master : null;
}

// Drive the context to 'running'. The TV may never receive a gesture, so
// besides the usual gesture listeners we also retry on a short timer:
// Chrome will let an AudioContext resume without a gesture once the
// origin's media-engagement score is high enough (the same exemption the
// music element already rides), so the polling eventually wins on a TV
// that's only ever watched, never touched. Polling stops the moment the
// context is running (or after a cap so we never spin forever).
(function installSfxUnlock() {
  if (typeof window === 'undefined') return;
  let settled = false;
  function done() {
    if (settled) return;
    settled = true;
    window.removeEventListener('pointerdown', kick, true);
    window.removeEventListener('keydown', kick, true);
    window.removeEventListener('touchend', kick, true);
    document.removeEventListener('visibilitychange', kick);
  }
  function kick() {
    const c = ctx();
    if (c && c.state === 'running') { done(); preloadAll(); }
  }
  window.addEventListener('pointerdown', kick, true);
  window.addEventListener('keydown', kick, true);
  window.addEventListener('touchend', kick, true);
  document.addEventListener('visibilitychange', kick);
  let tries = 0;
  const iv = setInterval(() => {
    tries += 1;
    const c = ctx();
    if ((c && c.state === 'running') || tries > 120) {
      clearInterval(iv);
      if (c && c.state === 'running') { done(); preloadAll(); }
    }
  }, 500);
})();

// ─── Sample playback ───
// Each .mp3 is fetched + decoded once into an AudioBuffer (cached by url)
// and replayed via throwaway BufferSourceNodes, so overlapping retriggers
// are free (every play is its own node) with none of the HTMLAudio pool
// bookkeeping or autoplay gating.
const _buffers = new Map(); // url -> Promise<AudioBuffer|null>
function loadBuffer(url) {
  if (_buffers.has(url)) return _buffers.get(url);
  const p = (async () => {
    const c = ctx();
    if (!c) return null;
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      return await new Promise((resolve, reject) => {
        // Promise + callback form both supported; callback form is the
        // only one older Safari honors.
        const ret = c.decodeAudioData(arr, resolve, reject);
        if (ret && ret.then) ret.then(resolve, reject);
      });
    } catch (e) {
      return null;
    }
  })();
  _buffers.set(url, p);
  return p;
}

// Fire a one-shot sample. volume is the per-sound level (0..1) on top of
// the master. Fire-and-forget; resolves the buffer lazily on first use.
function playSample(url, volume = 0.85) {
  if (_masterVolume <= 0) return;
  const m = master();
  if (!m) return;
  loadBuffer(url).then((buf) => {
    if (!buf) return;
    const c = ctx();
    if (!c) return;
    try {
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = volume;
      src.connect(g);
      g.connect(m);
      src.start(0);
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    } catch (e) {}
  });
}

// Looping sample with a managed handle so it can be stopped (and faded).
// Returns { stop(fadeMs) } or null. Used by heartbeat + the urgent timer.
function playLoop(url, volume) {
  const m = master();
  if (!m) return null;
  const handle = { src: null, gain: null, stopped: false };
  loadBuffer(url).then((buf) => {
    if (!buf || handle.stopped) return;
    const c = ctx();
    if (!c) return;
    try {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = c.createGain();
      g.gain.value = volume;
      src.connect(g);
      g.connect(m);
      src.start(0);
      handle.src = src;
      handle.gain = g;
    } catch (e) {}
  });
  handle.stop = (fadeMs = 0) => {
    handle.stopped = true;
    const c = ctx();
    const src = handle.src;
    const g = handle.gain;
    if (!src || !g || !c) return;
    try {
      if (fadeMs > 0) {
        const now = c.currentTime;
        const end = now + fadeMs / 1000;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0.0001, end);
        src.stop(end + 0.02);
      } else {
        src.stop();
      }
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    } catch (e) {}
  };
  return handle;
}

// ─── Operator sound overrides (from the /sounds admin) ───
// Fetched once on load: maps a trigger key -> an uploaded mp3 URL that replaces
// the built-in default for that game moment. Defaults play until this resolves
// (and forever if it fails or is empty), so the game always has sound.
const _overrides = Object.create(null);
// Per-trigger level (0..1.5), also from /sounds. Multiplies whatever plays for
// that moment — the operator's mp3 OR the built-in default — so the mix can be
// balanced without re-uploading. 1 (or absent) = the sound's own level.
const _volumes = Object.create(null);
function triggerGain(key) {
  const g = _volumes[key];
  return (typeof g === 'number' && isFinite(g)) ? g : 1;
}
if (typeof fetch !== 'undefined') {
  fetch('/api/sounds')
    .then((r) => r.json())
    .then((d) => {
      if (d && d.assignments) {
        Object.assign(_overrides, d.assignments);
        // Warm the buffers only if the context already exists (don't create one
        // prematurely); preloadAll() warms them post-unlock otherwise.
        if (_ctx) Object.values(_overrides).forEach((u) => loadBuffer(u));
      }
      if (d && d.volumes) Object.assign(_volumes, d.volumes);
    })
    .catch(() => {});
}
// Play the operator's assigned sound for `key` if there is one, else run the
// built-in default. `vol` is the base level for an override; the per-trigger
// gain scales both paths (the default receives it as a multiplier arg).
function fire(key, playDefault, vol = 0.85) {
  const g = triggerGain(key);
  const url = _overrides[key];
  if (url) { playSample(url, vol * g); return; }
  playDefault(g);
}

// Sample URLs. Kept together so preloadAll can warm them all once the
// context is live (removes first-play fetch/decode latency).
const S = {
  ding1: '/audio/misc/Ding1.mp3',
  // Space %20-encoded — fetched via loadBuffer, not an <audio src>.
  enteredRoom: '/audio/misc/Entered%20Room.mp3',
  bluff: '/audio/misc/Bluff.mp3',
  reveal: '/audio/misc/Reveal.mp3',
  trumpet: '/audio/misc/Trumpet.mp3',
  // Space is %20-encoded: this is fetched (loadBuffer), not set as an
  // <audio src>, and fetch() wants a valid URL.
  wordReveal: '/audio/misc/Word%20reveal.mp3',
  // Spaces %20-encoded — this is fetched (loadBuffer), not an <audio src>.
  heart: '/audio/misc/Heart%20Beat%201.mp3',
  move: '/audio/misc/Move.mp3',
  slide: '/audio/misc/Slide.mp3',
  tick: '/audio/misc/Tick1.mp3',
  tock: '/audio/misc/Tock1.mp3',
  timer: '/audio/misc/Timer.mp3',
  buzz: '/audio/misc/Buzzer.mp3',
  score: '/audio/misc/Scoreboard.mp3'
};
function preloadAll() {
  if (!ctx()) return;
  Object.values(S).forEach((u) => loadBuffer(u));
  Object.values(_overrides).forEach((u) => loadBuffer(u));
}

// ─── Synthesized tones ───
// Routed through the same master gain so master volume + the resumed
// context apply uniformly. `gain` is the raw per-tone level; the master
// node handles the user's volume.
function tone({ type = 'sine', freq, freqEnd, dur = 0.15, gain = 0.15, delay = 0, attack = 0.01 }) {
  if (_masterVolume <= 0) return;
  const c = ctx();
  const m = master();
  if (!c || !m) return;
  try {
    const t = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(m);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
  } catch (e) {}
}

// Soft tap — generic UI button feedback.
export function tap() {
  tone({ type: 'triangle', freq: 660, freqEnd: 440, dur: 0.07, gain: 0.10 });
}

// Confirm chime — two ascending notes. Use for major submissions.
export function confirm() {
  tone({ type: 'sine', freq: 587, dur: 0.10, gain: 0.13 });
  tone({ type: 'sine', freq: 880, dur: 0.16, gain: 0.13, delay: 0.08 });
}

// Pause — soft descending two-tone "settling" cue when the game is
// paused. Inverse of confirm(): confirm rises, pause falls, so the two
// read as opposites. Fires from the click handler itself, so it's always
// inside a user gesture and unlocks the context if it wasn't already.
export function pause() {
  tone({ type: 'sine', freq: 660, dur: 0.12, gain: 0.13 });             // E5
  tone({ type: 'sine', freq: 392, dur: 0.22, gain: 0.13, delay: 0.10 }); // G4
}

// Reveal — TV-side sound when a card flips. Real definition = the trumpet
// fanfare; every bluff = the Bluff sample (same for fooled or not; the
// per-player ding/gong split lives in revealPhone). `fooled` kept in the
// signature for callers but ignored here.
// eslint-disable-next-line no-unused-vars
export function reveal(isReal = false, fooled = false) {
  if (isReal) revealDefinition();
  else bluff();
}

// Phone-side reveal — ding (fooled) vs. gong (not fooled) so each player
// gets emotional feedback in their hand. Real definition reuses the
// celebratory chord.
export function revealPhone(isReal = false, fooled = false) {
  if (isReal) { reveal(true); return; }
  if (fooled) {
    tone({ type: 'sine', freq: 1046.50, dur: 1.4, gain: 0.16, attack: 0.005 });
    tone({ type: 'sine', freq: 1567.98, dur: 1.4, gain: 0.13, attack: 0.005 });
    tone({ type: 'sine', freq: 2093.00, dur: 1.2, gain: 0.09, attack: 0.005 });
    tone({ type: 'sine', freq: 783.99,  dur: 1.5, gain: 0.07, attack: 0.005 });
    tone({ type: 'triangle', freq: 3135.96, dur: 0.9, gain: 0.05, attack: 0.005, delay: 0.05 });
  } else {
    tone({ type: 'triangle', freq: 110,    freqEnd: 82,  dur: 0.45, gain: 0.32, attack: 0.002 });
    tone({ type: 'sawtooth', freq: 73,     dur: 0.18, gain: 0.18, attack: 0.001 });
    tone({ type: 'sine',     freq: 73.42,  dur: 3.5,  gain: 0.18, attack: 0.005 });
    tone({ type: 'sine',     freq: 76.50,  dur: 3.5,  gain: 0.14, attack: 0.005 });
    tone({ type: 'sine',     freq: 146.83, dur: 3.0,  gain: 0.16, attack: 0.005 });
    tone({ type: 'sine',     freq: 207,    dur: 2.8,  gain: 0.10, attack: 0.005 });
    tone({ type: 'sine',     freq: 277,    dur: 2.6,  gain: 0.09, attack: 0.005 });
    tone({ type: 'triangle', freq: 311,    dur: 2.5,  gain: 0.07, attack: 0.01,  delay: 0.02 });
    tone({ type: 'triangle', freq: 415,    dur: 2.3,  gain: 0.05, attack: 0.01,  delay: 0.04 });
    tone({ type: 'sine',     freq: 55,     dur: 2.5,  gain: 0.13, attack: 0.25,  delay: 0.10 });
  }
}

// The one-shot game cues below route through fire(): an operator-assigned mp3
// (from /sounds) wins, otherwise the built-in default in the second arg plays.

// Submit ding — fires on the TV each time a player's check mark lights up.
export function submitDing() { fire('answerLocked', (m = 1) => playSample(S.ding1, 0.85 * m)); }

// Vote-locked ding — fires on the player's phone when their vote confirms.
// Shares the same trigger as the submit ding.
export function voteLockedDing() { fire('answerLocked', (m = 1) => playSample(S.ding1, 0.85 * m)); }

// Entered-room — plays on the TV when a player joins and their piece pops
// into the room.
export function enteredRoom() { fire('joinRoom', (m = 1) => playSample(S.enteredRoom, 0.85 * m)); }

// Round intro — the cue when the "Next up / Round N" panel appears. A short,
// bright rising three-note flourish that reads as "here we go". Default is a
// synth tone; assign an mp3 on the Sound Board to replace it.
function _roundIntroSynth(m = 1) {
  tone({ type: 'triangle', freq: 587.33, dur: 0.16, gain: 0.13 * m, attack: 0.005 });              // D5
  tone({ type: 'triangle', freq: 739.99, dur: 0.18, gain: 0.13 * m, attack: 0.005, delay: 0.12 }); // F#5
  tone({ type: 'triangle', freq: 987.77, dur: 0.34, gain: 0.14 * m, attack: 0.005, delay: 0.24 }); // B5
  tone({ type: 'sine',     freq: 1975.53, dur: 0.5, gain: 0.04 * m, attack: 0.01,  delay: 0.28 }); // shimmer
}
export function roundIntro() { fire('roundIntro', _roundIntroSynth, 0.85); }

// Bluff — the TV cue when a bluff card is revealed.
export function bluff() { fire('bluffCard', (m = 1) => playSample(S.bluff, 0.85 * m)); }

// Bluff phase — the cue when the "somebody knows" panel appears (the players
// who got it right are now writing lies). A curious, rising "someone knows a
// secret" motif; distinct from the bluff-card flip. Default is a synth tone.
function _bluffPhaseSynth(m = 1) {
  tone({ type: 'sine',     freq: 523.25,  dur: 0.16, gain: 0.12 * m, attack: 0.006 });              // C5
  tone({ type: 'sine',     freq: 622.25,  dur: 0.18, gain: 0.12 * m, attack: 0.006, delay: 0.12 }); // D#5
  tone({ type: 'sine',     freq: 783.99,  dur: 0.30, gain: 0.13 * m, attack: 0.006, delay: 0.24 }); // G5
  tone({ type: 'triangle', freq: 1174.66, dur: 0.50, gain: 0.05 * m, attack: 0.01,  delay: 0.30 }); // shimmer
}
export function bluffPhase() { fire('bluffPhase', _bluffPhaseSynth, 0.85); }

// Voting intro — the cue when the "which one is true?" ballot appears. A
// two-note "make your choice" prompt with a light questioning lift at the end.
// Default is a synth tone; assign an mp3 on the Sound Board to replace it.
function _votingIntroSynth(m = 1) {
  tone({ type: 'sine',     freq: 659.25, dur: 0.16, gain: 0.12 * m, attack: 0.006 });              // E5
  tone({ type: 'sine',     freq: 880.00, dur: 0.22, gain: 0.13 * m, attack: 0.006, delay: 0.13 }); // A5
  tone({ type: 'triangle', freq: 1108.73, dur: 0.4, gain: 0.06 * m, attack: 0.01,  delay: 0.20 }); // lift
}
export function votingIntro() { fire('votingIntro', _votingIntroSynth, 0.85); }

// Reveal — the big cue when the REAL definition box/card shows up. A
// triumphant trumpet fanfare.
export function revealDefinition() { fire('truthReveal', (m = 1) => playSample(S.trumpet, 0.9 * m), 0.9); }

// Word reveal — fires on the TV the moment the question appears for everyone.
export function wordReveal() { fire('questionReveal', (m = 1) => playSample(S.wordReveal, 0.9 * m), 0.9); }

// Move — legacy sample (kept for reuse; superseded by slide()).
export function move() { playSample(S.move, 0.85); }

// Slide — played when a player's piece slides to a new spot on the board.
// ~50% quieter than the other cues so the repeated per-piece slides don't
// dominate the scoring sequence.
export function slide() { fire('pieceMove', (m = 1) => playSample(S.slide, 0.42 * m), 0.55); }

// Tick / Tock — alternating clock sound for the final TV countdown.
export function tick() { fire('countdownTick', (m = 1) => playSample(S.tick, 0.8 * m), 0.8); }
export function tock() { fire('countdownTock', (m = 1) => playSample(S.tock, 0.8 * m), 0.8); }

// Buzzer — the "time's up" blast when the countdown hits zero.
export function buzzer() { fire('timeUp', (m = 1) => playSample(S.buzz, 0.9 * m), 0.9); }

// Heartbeat — loops continuously through the real-definition suspense build.
// The caller starts it when the build begins and calls heartbeatStop() the
// moment it's no longer needed (the card flips), so it isn't tied to a fixed
// duration. Level 0.45 — present without being the overpowering 0.85 it
// used to be. Only one plays at a time; retriggering replaces it.
let _heart = null;
export function heartbeat() {
  if (_masterVolume <= 0) return;
  if (_heart) { try { _heart.stop(0); } catch (e) {} _heart = null; }
  // An assigned suspense sound loops in place of the heartbeat. The
  // per-trigger gain scales whichever is playing.
  const g = triggerGain('suspense');
  const url = _overrides['suspense'];
  _heart = playLoop(url || S.heart, (url ? 0.7 : 0.45) * g);
}
// Stop the heartbeat loop. Small default fade so it ducks cleanly into
// whatever plays next (e.g. the reveal trumpet) instead of cutting hard.
export function heartbeatStop(fadeMs = 250) {
  if (_heart) { try { _heart.stop(fadeMs); } catch (e) {} _heart = null; }
}

// Timer-urgent — loops continuously while the countdown is in the red
// zone, cut dead the instant the buzzer takes over. Parked on globalThis
// so a Vite HMR module swap can't orphan a still-looping source and stack
// a second one on top of it.
function _timerSlot() {
  const g = (typeof globalThis !== 'undefined') ? globalThis : window;
  return g;
}
export function timerUrgentStart() {
  if (_masterVolume <= 0) return;
  const slot = _timerSlot();
  if (slot.__wdTimerLoop) return; // idempotent: never stack a second loop
  const h = playLoop(S.timer, 0.85);
  if (h) slot.__wdTimerLoop = h;
}
export function timerUrgentStop() {
  const slot = _timerSlot();
  const h = slot.__wdTimerLoop;
  if (!h) return;
  try { h.stop(0); } catch (e) {}
  slot.__wdTimerLoop = null;
}

// Score — plays as scoring opens (right after the last bluff is revealed).
export function score() { fire('scoreboard', (m = 1) => playSample(S.score, 0.9 * m), 0.9); }

// Advance arrow — a quick rising "whoosh + ping" when a piece lands on an
// arrow tile and is nudged forward. Short and bright so it reads as a small
// bonus, not the long bridge fanfare. Fires as the piece launches forward.
function _advanceSynth(m = 1) {
  tone({ type: 'sine',     freq: 320, freqEnd: 1200, dur: 0.26, gain: 0.16 * m, attack: 0.005 });
  tone({ type: 'triangle', freq: 480, freqEnd: 1600, dur: 0.26, gain: 0.08 * m, attack: 0.005 });
  tone({ type: 'sine', freq: 1318.51, dur: 0.18, gain: 0.12 * m, attack: 0.004, delay: 0.22 }); // E6
  tone({ type: 'sine', freq: 1975.53, dur: 0.16, gain: 0.09 * m, attack: 0.004, delay: 0.28 }); // B6
}
export function advance() { fire('arrowBonus', _advanceSynth, 0.85); }

// Bonus coffee — a warm ascending three-note sparkle for landing on the
// coffee-cup tile (your next correct answer pays double). Distinct from
// advance() so the two bonuses are audibly different.
function _bonusSynth(m = 1) {
  tone({ type: 'sine',     freq: 659.25,  dur: 0.14, gain: 0.14 * m, attack: 0.005 });             // E5
  tone({ type: 'sine',     freq: 987.77,  dur: 0.20, gain: 0.14 * m, attack: 0.005, delay: 0.10 }); // B5
  tone({ type: 'sine',     freq: 1318.51, dur: 0.34, gain: 0.13 * m, attack: 0.005, delay: 0.20 }); // E6
  tone({ type: 'triangle', freq: 1975.53, dur: 0.55, gain: 0.05 * m, attack: 0.01,  delay: 0.24 }); // shimmer
}
export function bonus() { fire('coffeeBonus', _bonusSynth, 0.85); }

// Preview a trigger's built-in synth default. Used by the Sound Board so the
// operator can hear the generated tones (the triggers with no default file, so
// nothing for the HTMLAudio preview to play). `mul` scales it to the trigger's
// current volume. Returns true if a tone was played, false if the trigger has
// no synth default (its preview goes through its file URL instead).
const _defaultTones = {
  arrowBonus: _advanceSynth,
  coffeeBonus: _bonusSynth,
  bluffPhase: _bluffPhaseSynth,
  roundIntro: _roundIntroSynth,
  votingIntro: _votingIntroSynth,
  // Wrapped rather than referenced directly: the entries here are called as
  // fn(mul), and firework() takes an options object.
  winBoom: (mul) => firework({ gain: 0.95 * mul }),
};
export function playDefaultTone(key, mul = 1) {
  const fn = _defaultTones[key];
  if (!fn) return false;
  // On the Sound Board this click may be the page's FIRST user gesture, so the
  // AudioContext is still suspended. Scheduling oscillators into a suspended
  // context then resuming can drop the first tone — so resume first, then play
  // once it's actually running. (In-game cues fire on an already-running
  // context, so they don't need this.)
  const c = ctx();
  if (c && c.state !== 'running' && typeof c.resume === 'function') {
    c.resume().then(() => fn(mul)).catch(() => fn(mul));
  } else {
    fn(mul);
  }
  return true;
}

// Bridge — cinematic crossing cue synced to the 2.6s arc + landing.
export function bridge() {
  tone({ type: 'sine',     freq: 180, freqEnd: 1100, dur: 0.55, gain: 0.18, attack: 0.005 });
  tone({ type: 'sine',     freq: 240, freqEnd: 1320, dur: 0.55, gain: 0.11, attack: 0.005 });
  tone({ type: 'triangle', freq: 360, freqEnd: 1760, dur: 0.55, gain: 0.08, attack: 0.005 });
  tone({ type: 'sine', freq: 196.00, dur: 2.30, gain: 0.07, attack: 0.30, delay: 0.30 });
  tone({ type: 'sine', freq: 293.66, dur: 2.30, gain: 0.06, attack: 0.30, delay: 0.30 });
  tone({ type: 'sine', freq: 392.00, dur: 2.30, gain: 0.05, attack: 0.30, delay: 0.30 });
  tone({ type: 'sine', freq: 783.99,  dur: 0.65, gain: 0.11, attack: 0.005, delay: 0.65 });
  tone({ type: 'sine', freq: 987.77,  dur: 0.65, gain: 0.11, attack: 0.005, delay: 0.95 });
  tone({ type: 'sine', freq: 1174.66, dur: 0.65, gain: 0.11, attack: 0.005, delay: 1.25 });
  tone({ type: 'sine', freq: 1567.98, dur: 0.70, gain: 0.11, attack: 0.005, delay: 1.55 });
  tone({ type: 'sine', freq: 1975.53, dur: 0.70, gain: 0.10, attack: 0.005, delay: 1.85 });
  tone({ type: 'sine', freq: 2349.32, dur: 0.70, gain: 0.09, attack: 0.005, delay: 2.15 });
  tone({ type: 'sine',     freq: 880, freqEnd: 220, dur: 0.30, gain: 0.10, attack: 0.005, delay: 2.35 });
  tone({ type: 'triangle', freq: 660, freqEnd: 165, dur: 0.30, gain: 0.07, attack: 0.005, delay: 2.35 });
  tone({ type: 'triangle', freq: 90,  freqEnd: 60, dur: 0.35, gain: 0.20, attack: 0.002, delay: 2.55 });
  tone({ type: 'sine',     freq: 110, freqEnd: 70, dur: 0.45, gain: 0.11, attack: 0.005, delay: 2.55 });
  tone({ type: 'sine', freq: 196.00,  dur: 1.80, gain: 0.10, attack: 0.005, delay: 2.70 });
  tone({ type: 'sine', freq: 392.00,  dur: 1.80, gain: 0.13, attack: 0.005, delay: 2.70 });
  tone({ type: 'sine', freq: 493.88,  dur: 1.70, gain: 0.11, attack: 0.005, delay: 2.72 });
  tone({ type: 'sine', freq: 587.33,  dur: 1.70, gain: 0.11, attack: 0.005, delay: 2.72 });
  tone({ type: 'sine', freq: 783.99,  dur: 1.60, gain: 0.13, attack: 0.005, delay: 2.74 });
  tone({ type: 'sine', freq: 987.77,  dur: 1.50, gain: 0.10, attack: 0.005, delay: 2.74 });
  tone({ type: 'sine', freq: 1174.66, dur: 1.40, gain: 0.10, attack: 0.005, delay: 2.76 });
  tone({ type: 'sine', freq: 1567.98, dur: 1.30, gain: 0.09, attack: 0.005, delay: 2.78 });
  tone({ type: 'triangle', freq: 1975.53, dur: 1.0, gain: 0.06, attack: 0.005, delay: 2.78 });
  tone({ type: 'triangle', freq: 2349.32, dur: 0.9, gain: 0.05, attack: 0.005, delay: 2.81 });
  tone({ type: 'triangle', freq: 3135.96, dur: 0.8, gain: 0.04, attack: 0.005, delay: 2.84 });
}

// ─── Winner celebration audio ───
//
// Three cues, all operator-assignable from the /sounds admin: applause as
// the winner screen goes up, a reaction line dropped in over it, and a
// single boom when the confetti cannons fire. That's the whole celebration.
//
// It has been through two other shapes. Originally a four-note triangle
// arpeggio (C-E-G-C) over white-noise fireworks that kept popping on a loop
// until the screen unmounted — the archetypal cheap-browser-game sound, and
// it never ended. Then a full drum-roll → stinger → crowd → applause-bed
// sequence, which was a lot of production for a moment that reads better
// with one hit and then quiet.
//
// Each fires through its trigger key ('winApplause', 'winReaction',
// 'winBoom'), so whatever is dropped on those slots in the /sounds admin is
// what plays. An unassigned boom falls back to the synthesized firework
// below; the applause and the voice line are simply silent when unassigned.

// White-noise buffer (created once, reused) for the firework boom + crackle.
let _noiseBuf = null;
function noiseBuffer() {
  const c = ctx();
  if (!c) return null;
  if (_noiseBuf && _noiseBuf.sampleRate === c.sampleRate) return _noiseBuf;
  const len = Math.floor(c.sampleRate * 1.4);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  _noiseBuf = buf;
  return buf;
}

// The built-in default behind the 'winBoom' trigger: a deep boom (low sine
// thump + lowpassed noise punch) with a sparkly bandpassed-noise crackle
// tail on a flickering envelope. Exported so the Sound Board's "play the
// built-in tone" button can audition it.
export function firework(opts = {}) {
  if (_masterVolume <= 0) return;
  const c = ctx();
  const m = master();
  if (!c || !m) return;
  const t = c.currentTime + (opts.delay || 0);
  const level = opts.gain != null ? opts.gain : 0.9;

  // Boom — low sine thump.
  try {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(g); g.connect(m);
    osc.start(t); osc.stop(t + 0.4);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
  } catch (e) {}

  const nb = noiseBuffer();
  if (nb) {
    // Boom body — lowpassed noise punch.
    try {
      const src = c.createBufferSource();
      src.buffer = nb;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(420, t);
      const g = c.createGain();
      g.gain.setValueAtTime(0.35 * level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      src.connect(lp); lp.connect(g); g.connect(m);
      src.start(t); src.stop(t + 0.3);
      src.onended = () => { try { src.disconnect(); lp.disconnect(); g.disconnect(); } catch (e) {} };
    } catch (e) {}

    // Crackle tail — bandpassed noise with a flickering, popping envelope.
    try {
      const src = c.createBufferSource();
      src.buffer = nb;
      src.loop = true;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2800 + Math.random() * 900;
      bp.Q.value = 0.8;
      const g = c.createGain();
      const start = t + 0.05;
      const dur = 0.5 + Math.random() * 0.45;
      g.gain.setValueAtTime(0.0001, start);
      let tt = start;
      while (tt < start + dur) {
        const spike = 0.13 * level * (0.4 + Math.random() * 0.6);
        g.gain.linearRampToValueAtTime(spike, tt + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0009, tt + 0.04 + Math.random() * 0.03);
        tt += 0.03 + Math.random() * 0.045;
      }
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur + 0.05);
      src.connect(bp); bp.connect(g); g.connect(m);
      src.start(start); src.stop(start + dur + 0.1);
      src.onended = () => { try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch (e) {} };
    } catch (e) {}
  }
}

// The boom itself, routed through the operator override so the Sound Board
// owns it like every other cue in the game.
function winBoom() {
  fire('winBoom', (g) => firework({ gain: 0.95 * g }), 0.95);
}

// Applause as the winner screen goes up, under the build. No synthesized
// default: fake applause sounds worse than none, so an unassigned slot is
// simply silent and the screen still gets its boom.
function winApplause() {
  fire('winApplause', () => {}, 0.9);
}

// Reaction line over the top of the applause. Voice only — there is nothing
// sensible to synthesize, so an unassigned slot is silent.
function winReaction() {
  fire('winReaction', () => {}, 0.95);
}

// Win — the phone-side version of the moment. Same single boom as the TV so
// the room hits together on one sound rather than a chord of near-misses.
export function win() {
  winBoom();
}

// Start the winner celebration. Returns { stop() } so the screen cancels a
// boom that hasn't fired yet when it unmounts (hitting Play again during
// the build used to leave fireworks popping over the lobby).
//
// The boom is timed against winnerTiming.js, so it lands on the same frame
// the confetti cannons fire — not "roughly around then".
export function celebrationStart() {
  // Applause starts with the screen, the reaction line drops in over it, and
  // the boom lands on the confetti.
  winApplause();
  const timers = [
    setTimeout(winReaction, REVEAL.REACTION),
    setTimeout(winBoom, REVEAL.CANNON),
  ];
  return {
    stop() {
      timers.forEach(clearTimeout);
      timers.length = 0;
    },
  };
}
