// Central Perk'd server. Single Node process that:
//   1. Serves the built Vite client (or proxies to it in dev)
//   2. Runs the Socket.io game server with full room management
//
// Everything realtime goes through Socket.io. The HTTP side just serves
// the two static SPAs (TV view, phone controller) and a health probe.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sharp = require('sharp');
const Game = require('./game');
const Profiles = require('./profiles');
// Vendored from twen/twen-id/twen-verify.js — turns a TWEN access token into a
// verified identity using Supabase's published keys. No dependencies, no secret.
const TwenVerify = require('./twen-verify');

// Record per-account stats when a game ends. game.js fires this hook with
// the room (players carry an optional userId set at join from the phone's
// auth token). Guests/bots (no userId) are skipped.
Game.setOnGameOver((room, info) => {
  for (const p of room.players) {
    if (!p || p.isBot || !p.userId) continue;
    try {
      Profiles.recordGame({
        userId: p.userId,
        won: !!(info && info.winnerId && p.id === info.winnerId),
        correct: p.correct,
        bestStreak: p.bestStreak
      });
    } catch (e) { console.error('[profiles] record failed:', e); }
  }
});

// Trim transparent edges off an AI piece PNG so the figurine fills its
// bounds with no internal whitespace. gpt-image-1 always returns
// 1024x1024 with the character somewhere in the middle and 15-30% of the
// canvas transparent; without this, every render site needs negative
// margins to compensate. sharp's .trim() with a transparent background
// removes pixels matching the corner color (transparent), giving a tight
// content-box-cropped PNG. Falls back to the original buffer on any
// sharp error so a bad image doesn't fail the request.
async function trimAiPiecePng(buf) {
  try {
    // threshold: 15 catches anti-aliased semi-transparent fringe pixels
    // that gpt-image-1 leaves around the figurine outline. At threshold: 1
    // those survived and re-introduced a visible whitespace band, defeating
    // the trim. 15 still leaves the figurine's visible silhouette intact
    // (true content pixels are way more opaque than 15/255 alpha).
    return await sharp(buf)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 15 })
      .png()
      .toBuffer();
  } catch (e) {
    console.warn('[ai-piece-trim] fell back to untrimmed:', e.message);
    return buf;
  }
}

const PORT = process.env.PORT || 3000;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PUBLIC_LOGO_DIR = path.join(__dirname, '..', 'client', 'public');

// ─── AI piece generation ───
// Live OpenAI gpt-image-1 generation. Each player gets 2 attempts per join
// session (tracked by socket id). Style prompt locks the output to the
// existing chibi-figurine-on-wooden-base look so generated pieces blend with
// the stock catalog. Set OPENAI_API_KEY on the host to enable; without it,
// the endpoint reports the feature as unavailable so the client UI greys
// out gracefully.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
/* Uploads are things people made — generated pieces (an image call each) and
   sounds they recorded — and the container's own disk loses them at every
   deploy. PERKD_UPLOADS points at the mounted volume in production; locally it
   stays in the repo, exactly where it was. */
const UPLOAD_DIR = process.env.PERKD_UPLOADS || path.join(__dirname, 'uploads');
const AI_PIECE_DIR = path.join(UPLOAD_DIR, 'pieces');
const AI_GENERATIONS_PER_SOCKET = 2;

// ─── Sound board (operator-assignable game SFX) ───
// Uploaded mp3s live in a writable dir served at /sfx-audio (mirrors the
// /ai-pieces pattern); sounds.json maps a trigger key -> filename. sfx.js reads
// the resolved map from GET /api/sounds and overrides its built-in defaults.
// Declared here (before the static route + API routes that reference them).
const SOUNDS_DIR = path.join(UPLOAD_DIR, 'sounds');
const SOUNDS_FILE = process.env.PERKD_SOUNDS || path.join(__dirname, 'sounds.json');
const SOUND_TRIGGERS = require('./sound-triggers');
const SOUND_KEYS = new Set(SOUND_TRIGGERS.map((t) => t.key));
try { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); } catch (e) {}

// ─── Piece base styling ───
// The one knob that makes generated pieces look like THIS game's set. Both
// prompts below interpolate it, so changing these two strings restyles every
// future piece — no prompt surgery. Placeholder until the real Central Perk'd
// piece art is finalized.
const BASE_RIM_COLOR = 'deep purple';
const BASE_RIM_ICON = 'gold coffee-cup silhouette icon';
// Style prompt deliberately specific because gpt-image-1 reads "small
// circular wooden base" as a tree stump unless we push hard for the
// puck/coin shape and call out the green rim band + gold pine icon
// explicitly. Negative-style phrasing at the bottom counters the stump
// interpretation. The Subject section branches: creatures/characters get
// the chibi body+head treatment; inanimate objects (cars, food, etc.) are
// sculpted as the real object with NO added face/limbs, so "a dodge
// charger car" yields a car, not a car-headed mascot.
const AI_STYLE_PROMPT = [
  'A painted board game figurine miniature.',
  '',
  'Subject: {SUBJECT}.',
  '{SUBJECT_STYLE}',
  'Material: painted resin with detailed brush-stroke texture and warm ' +
    'cinematic lighting.',
  '',
  'Base: a thin flat circular puck-shaped wooden base, much wider than ' +
    'tall, like a polished coin or a hockey puck. The top of the base is ' +
    'plain smooth wood where the subject rests. The vertical side ' +
    'rim of the base is painted a wide dark forest-green stripe that fills ' +
    'nearly the full height of the rim. On the front of that green rim, ' +
    'dead center, is a single small gold pine-tree silhouette icon facing ' +
    'the camera.',
  '',
  'Composition: three-quarter front view, slight downward camera angle of ' +
    'about 10 degrees so the top of the base is partly visible. The subject ' +
    'is fully in frame from its highest point down to the bottom of the ' +
    'base, facing forward toward the camera.',
  '',
  'Style: matches a set of hand-painted resin collectible figurines. ' +
    'Warm golden-hour rim lighting, slight cinematic shadow, photographic ' +
    'realism on the painted texture.',
  '',
  'Background: plain transparent. No scene, no scenery, no ground shadow ' +
    'plate, no text, no signature, no watermark.',
  '',
  'IMPORTANT: the base is a FLAT round puck, NOT a tree stump, NOT a log, ' +
    'NOT a cylindrical chunk of wood, NOT irregular. The colored band wraps ' +
    'the vertical SIDE of the puck, not the top.',
  'IMPORTANT: never anthropomorphize an inanimate subject. A vehicle, ' +
    'object, or piece of food must have NO face, NO eyes, NO mouth, and NO ' +
    'limbs of any kind — render it as the real object, only miniaturized on ' +
    'the base.'
].join('\n');

// {SUBJECT_STYLE} variants chosen by the generator's Object/Character toggle.
// AUTO is the fallback (older clients / missing mode): let the model decide.
const SUBJECT_STYLE = {
  character:
    'Sculpt the subject chibi-style with the head about 35 to 40 percent of ' +
    'total height, in a neutral standing pose with arms relaxed at its sides.',
  object:
    'The subject is an inanimate object. Sculpt a faithful, accurate ' +
    'miniature of it exactly as it really looks in real life. Do NOT add a ' +
    'face, eyes, mouth, head, arms, hands, legs, or feet, and do NOT turn it ' +
    'into a creature, mascot, or character. It simply sits on the base as ' +
    'the object itself.',
  auto:
    'If the subject is a person, animal, creature, or character: sculpt it ' +
    'chibi-style with the head about 35 to 40 percent of total height, in a ' +
    'neutral standing pose with arms relaxed at its sides. If the subject ' +
    'is an object, vehicle, plant, food, or any inanimate thing: sculpt a ' +
    'faithful, accurate miniature of THAT object exactly as it really looks, ' +
    'with NO added face, eyes, head, or limbs — not a creature or mascot.'
};

// Build the final prompt for a subject + mode ('object' | 'character').
function buildAiPrompt(subject, mode) {
  const style = SUBJECT_STYLE[mode] || SUBJECT_STYLE.auto;
  return AI_STYLE_PROMPT
    .replace('{SUBJECT}', subject)
    .replace('{SUBJECT_STYLE}', style);
}

try { fs.mkdirSync(AI_PIECE_DIR, { recursive: true }); } catch (e) {}
const aiGenerationCounts = new Map(); // socketId -> count this session

// One-shot startup pass: re-trim every PNG already in AI_PIECE_DIR. Pieces
// generated before the sharp trim was added (or before the threshold was
// raised) still have transparent whitespace baked into their bounds; this
// fixes them in place so existing players don't need to regenerate.
// Skips files where the trimmed result isn't smaller (already tight).
// Logs counts so the deploy log shows whether the pass did anything.
async function retrimExistingPieces() {
  try {
    if (!fs.existsSync(AI_PIECE_DIR)) return;
    const files = fs.readdirSync(AI_PIECE_DIR).filter((f) => f.endsWith('.png'));
    let retrimmed = 0;
    let skipped = 0;
    let firstDims = null;
    for (const f of files) {
      const fp = path.join(AI_PIECE_DIR, f);
      try {
        const orig = fs.readFileSync(fp);
        const trimmed = await trimAiPiecePng(orig);
        if (trimmed.length < orig.length) {
          fs.writeFileSync(fp, trimmed);
          retrimmed += 1;
          if (!firstDims) {
            const before = await sharp(orig).metadata();
            const after = await sharp(trimmed).metadata();
            firstDims = before.width + 'x' + before.height + ' -> ' + after.width + 'x' + after.height;
          }
        } else {
          skipped += 1;
        }
      } catch (e) {
        console.warn('[retrim]', f, e.message);
      }
    }
    console.log('[retrim] retrimmed=' + retrimmed + ' skipped=' + skipped + ' total=' + files.length + (firstDims ? ' sample=' + firstDims : ''));
  } catch (e) {
    console.warn('[retrim] pass failed:', e.message);
  }
}
// Sanity check sharp loaded with its native binary, then kick off the
// retrim pass. If sharp.versions is missing, the native install failed
// and trim() will silently fall back to the original buffer.
try {
  console.log('[sharp]', sharp.versions ? 'loaded ' + JSON.stringify(sharp.versions) : 'NOT LOADED');
} catch (e) {
  console.warn('[sharp] check failed:', e.message);
}
retrimExistingPieces();

// Note: AI pieces used to generate 4 extra pose/expression variants
// (submitted / truth / book / megaphone) for the big cutscene figurines.
// Those figurines were removed from the game screens, so only the single
// base piece is generated now — no per-expression image-edit passes.

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  // Keep ping intervals short so we notice dropped phones quickly.
  pingInterval: 10000,
  pingTimeout: 15000
});

// ─── HTTP ROUTES ───
app.get('/api/health', (req, res) => res.json({
  ok: true,
  rooms: Game.roomCount(),
  aiPieces: !!OPENAI_API_KEY
}));

// ─── PLAYER ACCOUNTS ───
// Lightweight username + PIN accounts so players can keep an avatar and
// cross-game stats. Optional — guests never call any of this. Token is a
// stateless HMAC the phone stores in localStorage and sends on join.

// Resolve the Bearer token on a request to a public user, or null.
function userFromReq(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const uid = Profiles.verifyToken(m[1]);
  return uid ? Profiles.getUser(uid) : null;
}

// Crude per-IP throttle for login: 4–6 digit PINs are weak, so cap the
// guess rate. In-memory (resets on restart) — fine for this threat model.
const loginHits = new Map();
function loginThrottled(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const e = loginHits.get(ip);
  if (!e || now > e.resetAt) { loginHits.set(ip, { n: 1, resetAt: now + 10 * 60 * 1000 }); return false; }
  e.n += 1;
  return e.n > 20;
}

app.post('/api/auth/signup', express.json(), (req, res) => {
  const b = req.body || {};
  try {
    const user = Profiles.createUser(b.username, b.pin, b.avatar);
    res.json({ ok: true, token: Profiles.signToken(user.id), user });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/login', express.json(), (req, res) => {
  if (loginThrottled(req)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts — wait a few minutes.' });
  }
  const b = req.body || {};
  const user = Profiles.login(b.username, b.pin);
  if (!user) return res.status(401).json({ ok: false, error: 'Wrong username or PIN.' });
  res.json({ ok: true, token: Profiles.signToken(user.id), user });
});

/* Sign in with a TWEN account (twen.lol). The phone sends the access token it
   already holds; it is verified here against Supabase's published keys, so
   nothing on the client can claim to be someone it isn't. The response is the
   same { ok, token, user } shape as /login, leaving everything downstream —
   join, scoring, the profile card — untouched. */
app.post('/api/auth/twen', express.json(), async (req, res) => {
  let who = null;
  try {
    who = await TwenVerify.verifyTwenToken(String((req.body || {}).access_token || ''));
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'That TWEN sign-in could not be verified.' });
  }
  // An anonymous TWEN session is nobody in particular yet; a profile built on
  // one would vanish the moment they signed in properly.
  if (who.anonymous) {
    return res.status(400).json({ ok: false, error: 'Sign in to TWEN with Google first, then try again.' });
  }
  try {
    const user = Profiles.fromTwen(who);
    res.json({ ok: true, token: Profiles.signToken(user.id), user });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* Claim the profile already signed in here for a TWEN account, so existing
   stats keep counting after switching to Google. */
app.post('/api/auth/twen/link', express.json(), async (req, res) => {
  const mine = userFromReq(req);
  if (!mine) return res.status(401).json({ ok: false, error: 'Not signed in' });
  let who = null;
  try {
    who = await TwenVerify.verifyTwenToken(String((req.body || {}).access_token || ''));
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'That TWEN sign-in could not be verified.' });
  }
  if (who.anonymous) return res.status(400).json({ ok: false, error: 'Sign in to TWEN with Google first.' });
  try {
    res.json({ ok: true, user: Profiles.linkTwen(mine.id, who.id) });
  } catch (e) {
    res.status(409).json({ ok: false, error: e.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  res.json({ ok: true, user });
});

app.post('/api/auth/avatar', express.json(), (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  const updated = Profiles.setAvatar(user.id, (req.body || {}).avatar);
  res.json({ ok: true, user: updated || user });
});

// Static serve of AI-generated pieces. maxAge: 0 forces browsers to issue
// conditional (If-Modified-Since) requests, so a retrimmed piece reaches
// users on their next load instead of being shadowed by a stale 7-day
// cache of the old untrimmed PNG. Express still returns 304 when the file
// hasn't changed, so the overhead is just the header round-trip.
app.use('/ai-pieces', express.static(AI_PIECE_DIR, {
  maxAge: 0,
  fallthrough: false
}));

// Static serve of uploaded, operator-assignable game sounds (see /sounds
// admin). Registered before the SPA fallback so a fresh upload resolves
// immediately in prod; in dev Vite proxies /sfx-audio here.
app.use('/sfx-audio', express.static(SOUNDS_DIR, { maxAge: 0, fallthrough: false }));

// Serve songs from the SOURCE audio dir (where uploads land) so a freshly
// uploaded track resolves in production too. fallthrough:true so a miss still
// falls through to the dist/audio static + SPA fallback below. In dev, Vite
// serves /audio directly, so this is only exercised in production.
app.use('/audio', express.static(audioDir() || path.join(DIST_DIR, 'audio'), { fallthrough: true }));

// Transform-from-photo prompt. Used by the "Turn my photo into a figurine"
// flow on the join screen. Same end-state look as the text-prompt version
// (flat puck base + green rim + gold pine icon) but instructs the model to
// keep the person's face, hair, and clothing recognizable.
const AI_PHOTO_PROMPT = [
  'Transform this person into a chibi-proportioned hand-painted resin ' +
    'board game figurine that matches an existing miniature collectible set.',
  '',
  'Keep their recognizable features: face shape, eye color, hair style and ' +
    'color, skin tone, clothing colors and aesthetic. Stylize in a chibi ' +
    'proportion with the head about 35 to 40 percent of total height. ' +
    'Painted resin material with detailed brush-stroke texture and warm ' +
    'cinematic lighting on the body.',
  '',
  'Base: a thin flat circular puck-shaped wooden base, much wider than ' +
    'tall, like a polished coin. The vertical side rim of the base is ' +
    'painted a wide ' + BASE_RIM_COLOR + ' stripe. On the front of that ' +
    'rim, dead center, is a single small ' + BASE_RIM_ICON + ' facing the ' +
    'camera.',
  '',
  'Three-quarter front view, slight downward camera angle of about 10 ' +
    'degrees so the top of the base is partly visible. Neutral standing ' +
    'pose, facing forward.',
  '',
  'Background: plain transparent. No scene, no scenery, no ground shadow ' +
    'plate, no text, no signature, no watermark.',
  '',
  'IMPORTANT: the base is a FLAT round puck, NOT a tree stump, NOT a log, ' +
    'NOT a cylindrical chunk of wood. The green band wraps the vertical ' +
    'SIDE of the puck, not the top.'
].join('\n');

// Live AI piece generation. Body: { socketId, subject }.
// Returns { ok, url, remaining } on success, error JSON otherwise. Each
// socket can call this AI_GENERATIONS_PER_SOCKET times before being capped.
app.post('/api/generate-piece', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: 'AI piece generation is not configured on this server.' });
    }
    const body = req.body || {};
    const sid = String(body.socketId || '').slice(0, 64);
    const subject = String(body.subject || '').trim().slice(0, 200);
    if (subject.length < 2) {
      return res.status(400).json({ ok: false, error: 'Describe the piece in a few words.' });
    }
    const mode = body.mode === 'object' || body.mode === 'character' ? body.mode : 'auto';
    const used = aiGenerationCounts.get(sid) || 0;
    if (used >= AI_GENERATIONS_PER_SOCKET) {
      return res.status(429).json({
        ok: false,
        error: 'No AI generations left this game.',
        remaining: 0
      });
    }
    const prompt = buildAiPrompt(subject, mode);
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'medium',
        background: 'transparent'
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[ai-piece] OpenAI error', r.status, errText.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI service rejected the request.' });
    }
    const data = await r.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error('[ai-piece] OpenAI returned no image', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI returned no image.' });
    }
    const id = crypto.randomBytes(10).toString('hex');
    const filename = id + '.png';
    const baseBuf = await trimAiPiecePng(Buffer.from(b64, 'base64'));
    fs.writeFileSync(path.join(AI_PIECE_DIR, filename), baseBuf);
    aiGenerationCounts.set(sid, used + 1);
    return res.json({
      ok: true,
      url: '/ai-pieces/' + filename,
      remaining: Math.max(0, AI_GENERATIONS_PER_SOCKET - (used + 1))
    });
  } catch (e) {
    console.error('[ai-piece]', e);
    return res.status(502).json({ ok: false, error: 'Generation failed.' });
  }
});

// Photo-to-figurine. Body: { socketId, photoDataUrl }.
// Sends the selfie to OpenAI's images/edits endpoint with the photo-transform
// prompt, returns a figurine modeled after the person. Shares the same
// per-socket cap as /api/generate-piece (they're the same budget).
app.post('/api/generate-piece-from-photo', express.json({ limit: '600kb' }), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: 'AI piece generation is not configured on this server.' });
    }
    const body = req.body || {};
    const sid = String(body.socketId || '').slice(0, 64);
    const photoDataUrl = String(body.photoDataUrl || '');
    const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(photoDataUrl);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Invalid photo payload.' });
    }
    const mime = 'image/' + match[1];
    const photoBuf = Buffer.from(match[2], 'base64');
    if (photoBuf.length > 500000) {
      return res.status(413).json({ ok: false, error: 'Photo too large.' });
    }
    const used = aiGenerationCounts.get(sid) || 0;
    if (used >= AI_GENERATIONS_PER_SOCKET) {
      return res.status(429).json({
        ok: false,
        error: 'No AI generations left this game.',
        remaining: 0
      });
    }
    // OpenAI images/edits expects multipart form data. Node 20 has FormData
    // and Blob globals; we just need to construct the form and let fetch
    // attach the right multipart boundary.
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', AI_PHOTO_PROMPT);
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append('background', 'transparent');
    form.append('image', new Blob([photoBuf], { type: mime }), 'photo.' + match[1]);
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
      body: form
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[ai-piece-photo] OpenAI error', r.status, errText.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI service rejected the photo.' });
    }
    const data = await r.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error('[ai-piece-photo] OpenAI returned no image', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI returned no image.' });
    }
    const id = crypto.randomBytes(10).toString('hex');
    const filename = id + '.png';
    const baseBuf = await trimAiPiecePng(Buffer.from(b64, 'base64'));
    fs.writeFileSync(path.join(AI_PIECE_DIR, filename), baseBuf);
    aiGenerationCounts.set(sid, used + 1);
    return res.json({
      ok: true,
      url: '/ai-pieces/' + filename,
      remaining: Math.max(0, AI_GENERATIONS_PER_SOCKET - (used + 1))
    });
  } catch (e) {
    console.error('[ai-piece-photo]', e);
    return res.status(502).json({ ok: false, error: 'Generation failed.' });
  }
});

// ─── PLAYLIST ADMIN API ───
//
// Lightweight tool: lets the operator order the music tracks via a drag-and-
// drop UI at /playlist. Order persists to server/playlist.json (which is
// outside the static asset folders so dev/prod paths don't diverge). On
// Railway the filesystem is ephemeral across redeploys, so for permanent
// changes commit playlist.json into the repo.
//
// Auth is a single shared password (env `PLAYLIST_PASSWORD`, fallback
// 'centralperkd' with a startup warning). Sent as `Authorization: Bearer <pwd>`
// on every protected request.
const PLAYLIST_FILE = process.env.PERKD_PLAYLIST || path.join(__dirname, 'playlist.json');

/* First boot on a volume: these files aren't there yet, but the repo copies are.
   Seed rather than start empty — an order someone dragged into place, and the
   sound triggers they wired up, should not quietly reset the day this moves to
   persistent storage. */
[[PLAYLIST_FILE, path.join(__dirname, 'playlist.json')],
 [SOUNDS_FILE, path.join(__dirname, 'sounds.json')]].forEach(([live, seed]) => {
  if (live === seed) return;
  try {
    fs.mkdirSync(path.dirname(live), { recursive: true });
    if (!fs.existsSync(live) && fs.existsSync(seed)) {
      fs.copyFileSync(seed, live);
      console.log('[seed]', path.basename(live), 'copied from the repo copy');
    }
  } catch (e) {
    console.error('[seed] could not seed', live, e.message);
  }
});
const PLAYLIST_PASSWORD = process.env.PLAYLIST_PASSWORD || 'centralperkd';
if (!process.env.PLAYLIST_PASSWORD) {
  console.warn('[playlist] PLAYLIST_PASSWORD not set — using default "centralperkd". Set this env var in production.');
}
function audioDir() {
  // Source folder is the operator's source-of-truth (anything you drop into
  // client/public/audio/ shows up here). Falls back to the build output
  // for stripped-down deploys that ship dist/ without the source. Source
  // wins so a stale dist/audio/ from an old build can't shadow the live
  // music files.
  const candidates = [
    path.join(__dirname, '..', 'client', 'public', 'audio'),
    path.join(DIST_DIR, 'audio')
  ];
  return candidates.find((d) => fs.existsSync(d)) || null;
}
// Starter "vibes" (genre playlists). Names are freely editable in the editor;
// the stable `id` is what activeVibeId and the TV reference, so a rename never
// breaks playback. Used when no playlist.json exists and to migrate a legacy
// flat { tracks: [...] } file.
const DEFAULT_VIBES = [
  { id: 'sitcom',      name: 'Sitcom Sunshine', tracks: [] },
  { id: 'coffeehouse', name: 'Coffee House',    tracks: [] },
  { id: 'nineties',    name: '90s Throwback',   tracks: [] },
  { id: 'chill',       name: 'Chill Gaming',    tracks: [] }
];

function slugify(s, fallback) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

// Normalize any persisted shape into { activeVibeId, vibes:[{id,name,tracks}] }.
// Accepts the current vibes shape, a legacy flat { tracks:[...] } (migrated
// into the first default vibe), or junk (falls back to DEFAULT_VIBES).
function normalizePlaylist(parsed) {
  let vibes = [];
  if (parsed && Array.isArray(parsed.vibes)) {
    const seen = new Set();
    vibes = parsed.vibes
      .filter((v) => v && typeof v === 'object')
      .map((v, i) => {
        let id = slugify(v.id, '') || slugify(v.name, '') || ('vibe-' + (i + 1));
        while (seen.has(id)) id += '-' + (i + 1);
        seen.add(id);
        return {
          id,
          name: (typeof v.name === 'string' && v.name.trim()) || ('Vibe ' + (i + 1)),
          tracks: Array.isArray(v.tracks) ? v.tracks.filter((t) => typeof t === 'string') : []
        };
      });
  } else if (parsed && Array.isArray(parsed.tracks)) {
    // Legacy flat playlist → keep the tracks under the first default vibe.
    vibes = DEFAULT_VIBES.map((v, i) => ({
      ...v,
      tracks: i === 0 ? parsed.tracks.filter((t) => typeof t === 'string') : []
    }));
  }
  if (vibes.length === 0) vibes = DEFAULT_VIBES.map((v) => ({ ...v, tracks: [] }));
  let activeVibeId = parsed && typeof parsed.activeVibeId === 'string' ? parsed.activeVibeId : null;
  if (!vibes.some((v) => v.id === activeVibeId)) activeVibeId = vibes[0].id;
  return { activeVibeId, vibes, volumes: sanitizeVolumes(parsed && parsed.volumes) };
}

// Per-song playback gain, keyed by filename. Clamped 0..1.5 (1 = unchanged);
// anything non-numeric or out of range is dropped so a bad value can't break
// playback. `allowed` (optional Set of on-disk files) prunes stale entries.
function sanitizeVolumes(v, allowed) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [f, g] of Object.entries(v)) {
      const n = Number(g);
      if (typeof f === 'string' && isFinite(n) && (!allowed || allowed.has(f))) {
        out[f] = Math.max(0, Math.min(1.5, n));
      }
    }
  }
  return out;
}

function readPlaylist() {
  try {
    return normalizePlaylist(JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8')));
  } catch (e) {
    return normalizePlaylist(null);
  }
}
function writePlaylist(data) {
  fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(data, null, 2));
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== PLAYLIST_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// Verify a password — frontend uses this to decide whether to show the editor.
app.post('/api/playlist/login', express.json(), (req, res) => {
  const pwd = req.body && req.body.password;
  if (pwd === PLAYLIST_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

// List all .mp3 files in the audio directory (excluding the misc/ subfolder
// of one-off SFX). Returns just filenames; the client prefixes /audio/.
app.get('/api/playlist/files', (req, res) => {
  const dir = audioDir();
  if (!dir) return res.json({ ok: true, files: [] });
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.mp3$/i.test(f))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get the saved playlist (all vibes + which one is live). Public — the TV
// reads this on every page load so changes take effect with no extra wiring.
app.get('/api/playlist', (req, res) => {
  res.json({ ok: true, ...readPlaylist() });
});

// Save the playlist. Auth required.
// Body: { activeVibeId, vibes: [{ id, name, tracks: [filename, ...] }] }.
app.post('/api/playlist', express.json(), requireAuth, (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.vibes)) {
    return res.status(400).json({ ok: false, error: 'vibes must be an array' });
  }
  // Defensive: keep only on-disk filenames, dedupe within a vibe, and keep
  // vibe ids stable + unique so a rename never breaks the active reference.
  const dir = audioDir();
  const allowed = dir ? new Set(fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f))) : null;
  const seenIds = new Set();
  const vibes = body.vibes
    .filter((v) => v && typeof v === 'object')
    .map((v, i) => {
      let id = slugify(v.id, '') || slugify(v.name, '') || ('vibe-' + (i + 1));
      while (seenIds.has(id)) id += '-' + (i + 1);
      seenIds.add(id);
      const tracks = [];
      const seenTracks = new Set();
      (Array.isArray(v.tracks) ? v.tracks : [])
        .filter((t) => typeof t === 'string')
        .map((t) => t.replace(/^\/?audio\//, ''))
        .forEach((t) => {
          if (seenTracks.has(t) || (allowed && !allowed.has(t))) return;
          seenTracks.add(t);
          tracks.push(t);
        });
      return {
        id,
        name: (typeof v.name === 'string' && v.name.trim()) || ('Vibe ' + (i + 1)),
        tracks
      };
    });
  if (vibes.length === 0) {
    return res.status(400).json({ ok: false, error: 'at least one vibe is required' });
  }
  let activeVibeId = typeof body.activeVibeId === 'string' ? body.activeVibeId : null;
  if (!vibes.some((v) => v.id === activeVibeId)) activeVibeId = vibes[0].id;
  const volumes = sanitizeVolumes(body.volumes, allowed);
  try {
    const data = { activeVibeId, vibes, volumes };
    writePlaylist(data);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload a song mp3 as raw bytes (name in ?name=). Writes into the audio dir so
// it lists + plays exactly like a pre-placed song. Auth required.
app.post('/api/playlist/upload',
  requireAuth,
  express.raw({ type: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'], limit: '25mb' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'No audio data received.' });
    }
    const dir = audioDir();
    if (!dir) return res.status(500).json({ ok: false, error: 'No audio directory available.' });
    const filename = safeSoundName(req.query.name); // shared .mp3 name sanitizer
    try {
      fs.writeFileSync(path.join(dir, filename), req.body);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save the file.' });
    }
    res.json({ ok: true, filename });
  });

// Delete an uploaded song: remove the file from disk AND strip it from every
// vibe + its per-song volume, so nothing dangles. Auth required.
app.delete('/api/playlist/files/:name', requireAuth, (req, res) => {
  const dir = audioDir();
  const filename = safeSoundName(req.params.name);
  if (dir) { try { fs.unlinkSync(path.join(dir, filename)); } catch (e) {} }
  const pl = readPlaylist();
  pl.vibes = pl.vibes.map((v) => ({ ...v, tracks: v.tracks.filter((t) => t !== filename) }));
  if (pl.volumes) delete pl.volumes[filename];
  try { writePlaylist(pl); } catch (e) {}
  const files = dir
    ? fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    : [];
  res.json({ ok: true, files });
});

// ─── SOUND BOARD routes (auth reuses PLAYLIST_PASSWORD / requireAuth) ───
// sounds.json is { assignments: { key: filename }, volumes: { key: gain } }.
// A legacy flat { key: filename } file (no wrapper) is migrated on read.
function readSounds() {
  let parsed = {};
  try { const p = JSON.parse(fs.readFileSync(SOUNDS_FILE, 'utf8')); if (p && typeof p === 'object' && !Array.isArray(p)) parsed = p; } catch (e) {}
  if (!parsed.assignments && !parsed.volumes) return { assignments: parsed, volumes: {} };
  return {
    assignments: (parsed.assignments && typeof parsed.assignments === 'object') ? parsed.assignments : {},
    volumes: (parsed.volumes && typeof parsed.volumes === 'object') ? parsed.volumes : {}
  };
}
function writeSounds(data) {
  fs.writeFileSync(SOUNDS_FILE, JSON.stringify({
    assignments: data.assignments || {}, volumes: data.volumes || {}
  }, null, 2));
}
function soundFilesOnDisk() {
  try {
    return fs.readdirSync(SOUNDS_DIR)
      .filter((f) => /\.mp3$/i.test(f))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch (e) { return []; }
}
// Reduce any uploaded name to a safe .mp3 basename (no paths, no odd chars).
function safeSoundName(name) {
  let base = String(name || '').split(/[\\/]/).pop() || '';
  base = base.replace(/\.mp3$/i, '').replace(/[^a-zA-Z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!base) base = 'sound-' + Date.now().toString(36);
  return base + '.mp3';
}

// Public: the trigger catalog + resolved assignments the sfx layer consumes.
// Only assignments whose file still exists on disk are surfaced.
app.get('/api/sounds', (req, res) => {
  const onDisk = new Set(soundFilesOnDisk());
  const { assignments: saved, volumes: savedVol } = readSounds();
  const assignments = {};
  for (const [key, file] of Object.entries(saved)) {
    if (SOUND_KEYS.has(key) && typeof file === 'string' && onDisk.has(file)) {
      assignments[key] = '/sfx-audio/' + encodeURIComponent(file);
    }
  }
  // Per-trigger playback gain (applies to the default OR the custom sound).
  const volumes = {};
  for (const [key, g] of Object.entries(savedVol)) {
    const n = Number(g);
    if (SOUND_KEYS.has(key) && isFinite(n)) volumes[key] = Math.max(0, Math.min(1.5, n));
  }
  res.json({ ok: true, triggers: SOUND_TRIGGERS, assignments, volumes });
});

// Auth: list uploaded sound files.
app.get('/api/sounds/files', requireAuth, (req, res) => {
  res.json({ ok: true, files: soundFilesOnDisk() });
});

// Auth: save the trigger -> file assignments (validated against keys + disk).
app.post('/api/sounds', requireAuth, express.json(), (req, res) => {
  const inAssign = (req.body && typeof req.body.assignments === 'object' && req.body.assignments) || {};
  const inVol = (req.body && typeof req.body.volumes === 'object' && req.body.volumes) || {};
  const onDisk = new Set(soundFilesOnDisk());
  const assignments = {};
  for (const [key, file] of Object.entries(inAssign)) {
    if (SOUND_KEYS.has(key) && typeof file === 'string' && onDisk.has(file)) assignments[key] = file;
  }
  // Store only non-default gains, keyed by trigger (valid for default sounds too).
  const volumes = {};
  for (const [key, g] of Object.entries(inVol)) {
    const n = Number(g);
    if (SOUND_KEYS.has(key) && isFinite(n) && n !== 1) volumes[key] = Math.max(0, Math.min(1.5, n));
  }
  try {
    writeSounds({ assignments, volumes });
    res.json({ ok: true, assignments, volumes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Auth: upload an mp3 as raw bytes (name in ?name=). No multipart dep needed.
app.post('/api/sounds/upload',
  requireAuth,
  express.raw({ type: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'], limit: '15mb' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'No audio data received.' });
    }
    const filename = safeSoundName(req.query.name);
    try {
      fs.writeFileSync(path.join(SOUNDS_DIR, filename), req.body);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save the file.' });
    }
    res.json({ ok: true, filename, url: '/sfx-audio/' + encodeURIComponent(filename) });
  });

// Auth: delete an uploaded sound + clear any assignment that pointed at it.
app.delete('/api/sounds/files/:name', requireAuth, (req, res) => {
  const filename = safeSoundName(req.params.name);
  try { fs.unlinkSync(path.join(SOUNDS_DIR, filename)); } catch (e) {}
  const data = readSounds();
  let changed = false;
  for (const [key, file] of Object.entries(data.assignments)) {
    if (file === filename) { delete data.assignments[key]; changed = true; }
  }
  // Leave the trigger's volume in place — it still applies to the default sound.
  if (changed) { try { writeSounds(data); } catch (e) {} }
  res.json({ ok: true, files: soundFilesOnDisk() });
});

// ─── GAME SETTINGS (persistent defaults for new games, edited at /admin) ───
// Auth: return the saved defaults + the valid option lists so the form renders
// the exact choices.
app.get('/api/game-settings', requireAuth, (req, res) => {
  res.json({ ok: true, settings: Game.readDefaults(), ...Game.settingsMeta() });
});
// Auth: validate + persist the defaults; echoes back the sanitized result.
app.post('/api/game-settings', requireAuth, express.json(), (req, res) => {
  const incoming = (req.body && typeof req.body.settings === 'object' && req.body.settings) || {};
  try {
    res.json({ ok: true, settings: Game.writeDefaults(incoming) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// In production the Vite build output lives in /dist. We map the two
// SPA entry HTMLs to friendly URLs.
//
// HTML files are served with no-cache headers so a fresh build is picked up
// on the next page load — otherwise browsers (especially Brave/Chrome) can
// hold onto stale tv.html with broken references to old hashed CSS/JS.
// The hashed asset files in /assets are immutable and benefit from caching.
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  }));
  function sendHtml(file) {
    return (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(DIST_DIR, file));
    };
  }
  app.get(['/tv', '/tv/'], sendHtml('tv.html'));
  app.get(['/join', '/join/'], sendHtml('phone.html'));
  app.get(['/playlist', '/playlist/'], sendHtml('playlist.html'));
  app.get(['/sounds', '/sounds/'], sendHtml('sounds.html'));
  app.get(['/admin', '/admin/'], sendHtml('admin.html'));
  app.get('/', sendHtml('index.html'));
} else {
  // Dev fallback: tell the developer to run the Vite dev server.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/socket.io')) return res.status(404).end();
    res.status(503).send(
      '<h1>Central Perk&rsquo;d dev mode</h1>' +
      '<p>The client build is not present. Run <code>npm run dev</code> ' +
      '(or <code>npm run dev:client</code> in another terminal) and open ' +
      '<a href="http://localhost:5173/tv.html">localhost:5173/tv.html</a>.</p>'
    );
  });
}

// ─── SOCKET.IO ───
//
// Client roles:
//   - 'tv':     the shared screen (one per room, generates the room code)
//   - 'player': a phone controller (1..10 per room)
//
// Outbound events: 'state' (full room snapshot for the recipient's role)
// Inbound events:  see Game.handle()

io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.roomCode = null;
  socket.data.playerId = null;

  // The TV opens first and creates a room. Server returns the code.
  socket.on('tv:create', (cb) => {
    const room = Game.createRoom(socket.id);
    socket.data.role = 'tv';
    socket.data.roomCode = room.code;
    socket.join('tv:' + room.code);
    socket.join(room.code);
    Game.broadcast(io, room.code);
    if (typeof cb === 'function') cb({ ok: true, code: room.code });
  });

  // Admin: simulate a 4-bot game so the developer can see the full flow.
  // Only works from a TV socket on an empty lobby.
  socket.on('tv:simulate', (cb) => {
    if (socket.data.role !== 'tv') return cb && cb({ ok: false, error: 'tv only' });
    const code = socket.data.roomCode;
    if (!code) return cb && cb({ ok: false, error: 'no room' });
    const ok = Game.startSimulation(io, code);
    cb && cb({ ok });
  });

  // A returning TV (e.g. after refresh with the same code in the URL)
  // can reattach to an existing room.
  socket.on('tv:attach', ({ code }, cb) => {
    code = String(code || '').toUpperCase();
    const room = Game.getRoom(code);
    if (!room) return cb && cb({ ok: false, error: 'room not found' });
    socket.data.role = 'tv';
    socket.data.roomCode = code;
    socket.join('tv:' + code);
    socket.join(code);
    // Register this socket as a TV for the room. broadcast() emits 'state'
    // ONLY to the socket ids in room.tvSocketIds, so without this a TV that
    // reattaches after a refresh (room still alive) would join the rooms but
    // never receive a snapshot — leaving it stuck on the boot screen.
    room.tvSocketIds.add(socket.id);
    Game.broadcast(io, code);
    cb && cb({ ok: true, code });
  });

  // Pre-join lookup so the join screen can gray out already-taken pieces.
  socket.on('room:peek', ({ code }, cb) => {
    const result = Game.peekRoom(String(code || '').toUpperCase());
    cb && cb(result);
  });

  // A phone joins. Receives a stable playerId it should reuse on reconnect.
  socket.on('player:join', ({ code, name, piece, playerId, authToken }, cb) => {
    try {
      // `piece` is either a fixed piece id (e.g. "lantern") or a data URL of
      // the player's selfie from PhotoCapture. Validate the data URL form so
      // we don't accept arbitrarily large or malformed payloads (default
      // Socket.io buffer is 1MB; we cap at 400KB for headroom).
      const rawPiece = typeof piece === 'string' ? piece : '';
      if (rawPiece.startsWith('data:image/')) {
        if (rawPiece.length > 400000) return cb && cb({ ok: false, error: 'Photo too large' });
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(rawPiece)) {
          return cb && cb({ ok: false, error: 'Invalid photo' });
        }
      }
      // AI-generated piece URL — must match the exact path we wrote on
      // /api/generate-piece, and the file must actually exist on disk so a
      // malicious client can't claim a URL the server never produced.
      if (rawPiece.startsWith('/ai-pieces/')) {
        if (!/^\/ai-pieces\/[a-f0-9]+\.png$/.test(rawPiece)) {
          return cb && cb({ ok: false, error: 'Invalid AI piece URL' });
        }
        const onDisk = path.join(AI_PIECE_DIR, rawPiece.slice('/ai-pieces/'.length));
        if (!fs.existsSync(onDisk)) {
          return cb && cb({ ok: false, error: 'AI piece file missing' });
        }
      }
      // Optional account link: a valid token ties this seat to a profile so
      // results count toward their stats. Invalid/absent token → guest.
      const userId = authToken ? Profiles.verifyToken(authToken) : null;
      const result = Game.joinRoom({
        code: String(code || '').toUpperCase(),
        name: String(name || '').trim(),
        piece: rawPiece,
        existingPlayerId: playerId || null,
        socketId: socket.id,
        userId: userId || null
      });
      // Remember the avatar they joined with on their profile.
      if (userId && rawPiece) {
        try { Profiles.setAvatar(userId, rawPiece); } catch (e) {}
      }
      socket.data.role = 'player';
      socket.data.roomCode = result.code;
      socket.data.playerId = result.playerId;
      socket.join(result.code);
      socket.join('player:' + result.playerId);
      Game.broadcast(io, result.code);
      cb && cb({ ok: true, playerId: result.playerId, code: result.code });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // Generic in-game action dispatcher. The Game module knows what each
  // action means at each phase. Returning false means "ignored".
  socket.on('action', async (payload, cb) => {
    try {
      // Some actions are async — submitting an answer or a bluff runs the
      // judging funnel, which may make an AI call. Await before acking so the
      // phone learns its own verdict from the ack, not a later broadcast.
      const result = await Game.handle(io, {
        socket,
        role: socket.data.role,
        roomCode: socket.data.roomCode,
        playerId: socket.data.playerId,
        action: payload && payload.type,
        data: payload && payload.data
      });
      // handle() returns either a boolean (plain ok flag) or an object with
      // extra payload (e.g. randomBluff returning { ok, text }).
      if (result && typeof result === 'object') {
        cb && cb(result);
      } else {
        cb && cb({ ok: !!result });
      }
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    Game.handleDisconnect(io, socket);
  });
});

// Periodic housekeeping: drop rooms that have been idle for 2 hours.
setInterval(() => Game.evictIdleRooms(io), 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Central Perk'd listening on :${PORT}`);
  console.log(`  TV view:   http://localhost:${PORT}/tv`);
  console.log(`  Phone:     http://localhost:${PORT}/join`);
});
