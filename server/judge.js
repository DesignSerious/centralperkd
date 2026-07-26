// Answer judging — the three-tier funnel.
//
// Every ANSWERING submission is judged the moment it arrives, so by the time
// the timer ends the server already knows who was right. Cheapest tier first:
//
//   1. Normalized exact match against `answer` + `altAnswers`.        (~0ms)
//   2. Fuzzy match — token containment + edit distance, threshold      (~0ms)
//      scaled to answer length. Catches typos and padding words.
//   3. AI semantic judge — one small-model call, only for what tiers   (~1s)
//      1–2 left unresolved, capped per round.
//
// Tier 3 is fired while the answer clock is still running, so its latency is
// hidden inside the phase. If it errors or times out we keep tier 2's verdict:
// that can occasionally mark a paraphrased-correct answer wrong, which is the
// acceptable failure direction (a false "wrong" costs the player 2 spaces; a
// false "correct" would put a second truth on the ballot and break the round).
//
// The same funnel runs in BLUFFING with the opposite polarity — a crafted lie
// that judges as "correct" is rejected so the ballot never holds two truths.

const Questions = require('./questions');

// ─── tuning ───
const AI_MODEL = 'gpt-4o-mini';        // small + fast; the judge is a yes/no call
const AI_TIMEOUT_MS = 5000;            // per-attempt; generous for Railway->OpenAI latency
const AI_RETRIES = 1;                  // one retry so a transient blip doesn't stamp a correct answer WRONG
const AI_CALLS_PER_ROUND = 8;
// Tier-2 thresholds. Short answers ("Kip", "Yemen") must match tightly —
// one edit is most of the string — while long answers ("she left her fiancé at
// the altar") tolerate more slop because the tokens carry the meaning.
const FUZZY_TOKEN_OVERLAP = 0.7;       // share of the real answer's key words present
const SHORT_ANSWER_CHARS = 8;          // at or below this, require a near-exact match
// Answers this short get NO typo budget. On a 3-letter name one edit reaches a
// different valid answer ("Kip" -> "Kim"), and a false "correct" is the
// dangerous direction: it puts a second truth on the ballot.
const EXACT_ONLY_CHARS = 4;

// Filler words stripped before comparison. Deliberately small: these are words
// that never carry the answer, so dropping them turns "he fell asleep during
// it" and "fell asleep" into the same string.
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'he', 'she', 'it', 'they', 'them', 'his', 'her', 'their', 'its',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that', 'this', 'these', 'those',
  'and', 'or', 'but', 'so', 'because', 'as', 'by', 'from', 'about',
  'i', 'think', 'thinks', 'thought', 'maybe', 'probably', 'like', 'just',
  'did', 'does', 'do', 'had', 'has', 'have', 'got', 'get', 'gets',
  'answer', 'its'
]);

// Shared normalizer — lowercase, strip accents and punctuation, collapse
// whitespace. Mirrors client/src/lib/normalize.js so what a player sees in
// their "submitted" confirmation is what the server compared.
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // fiancé -> fiance
    .replace(/[-–—_/]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalize(s).split(' ').filter((w) => w && !FILLER.has(w));
}

// ─── tier 1: exact ───
function tier1(submission, q) {
  const sub = normalize(submission);
  if (!sub) return false;
  const candidates = [q.answer, ...(q.altAnswers || [])];
  return candidates.some((c) => normalize(c) === sub);
}

// Levenshtein, iterative two-row. Inputs here are short (< 120 chars), so the
// O(n*m) cost is irrelevant and a dependency would be silly.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// ─── tier 2: fuzzy ───
// Two independent routes to a match, because the failure modes differ:
//   - typo route: whole-string edit distance within a length-scaled budget
//   - phrasing route: the real answer's meaningful words are all present in
//     the submission (handles "he fell asleep during it" vs "fell asleep")
function tier2(submission, q) {
  const sub = normalize(submission);
  if (!sub) return false;
  const subTokens = tokens(submission);
  if (!subTokens.length) return false;

  for (const candidate of [q.answer, ...(q.altAnswers || [])]) {
    const cand = normalize(candidate);
    if (!cand) continue;

    // Typo route. Budget: ~1 edit per 8 chars, and zero on very short answers
    // where one edit lands on a different answer entirely.
    const budget = cand.length <= EXACT_ONLY_CHARS ? 0
      : cand.length <= SHORT_ANSWER_CHARS ? 1
      : Math.max(1, Math.floor(cand.length / 8));
    if (editDistance(sub, cand) <= budget) return true;

    // Phrasing route. Short answers are excluded — with one key word, "present
    // in the submission" is too easy to satisfy by accident.
    const candTokens = tokens(candidate);
    if (candTokens.length >= 2) {
      const subSet = new Set(subTokens);
      let hit = 0;
      for (const t of candTokens) {
        if (subSet.has(t)) { hit += 1; continue; }
        // Near-miss on a single token (plural, tense) still counts.
        if (subTokens.some((s) => Math.abs(s.length - t.length) <= 2 && editDistance(s, t) <= 1)) hit += 1;
      }
      if (hit / candTokens.length >= FUZZY_TOKEN_OVERLAP) return true;
    } else if (candTokens.length === 1) {
      // Single-key-word answers ("Kip", "Yemen", "kiwi"): the word must appear
      // as its own token in the submission, not as a substring.
      const key = candTokens[0];
      if (subTokens.some((s) => s === key || (key.length > EXACT_ONLY_CHARS && editDistance(s, key) <= 1))) return true;
    }
  }
  return false;
}

// ─── tier 3: AI semantic judge ───
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
function aiAvailable() { return !!OPENAI_API_KEY; }

function buildPrompt(q, submission) {
  return [
    'Question: ' + q.question,
    'Real answer: ' + q.answer,
    'A player answered: ' + submission,
    '',
    'Would a reasonable trivia host, reading answers aloud, count the ' +
      "player's answer as correct? Accept different wording, partial " +
      'phrasing, and minor detail gaps if the player clearly knows the ' +
      'answer. Reject answers that name a different person, thing, or event.',
    'Reply with exactly one word: correct or wrong.'
  ].join('\n');
}

async function tier3(submission, q) {
  if (!aiAvailable()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 4,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a fair but strict trivia judge. Reply with only the word correct or wrong.' },
          { role: 'user', content: buildPrompt(q, submission) }
        ]
      })
    });
    if (!r.ok) {
      console.warn('[judge] OpenAI', r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const data = await r.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content || '').trim().toLowerCase();
    if (text.startsWith('correct')) return true;
    if (text.startsWith('wrong')) return false;
    console.warn('[judge] unparseable verdict:', text.slice(0, 40));
    return null;
  } catch (e) {
    // Abort (timeout) or network failure — caller keeps the tier-2 verdict.
    console.warn('[judge] AI judge unavailable:', e.name === 'AbortError' ? 'timed out' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── public: judge one submission ───
//
// budget is a per-round mutable counter ({ left: N }) so a pathological round
// can't fan out to one AI call per player per keystroke. Returns:
//   { correct, tier, aiUsed }
async function judgeAnswer(submission, q, budget) {
  if (tier1(submission, q)) return { correct: true, tier: 1, aiUsed: false };

  const fuzzy = tier2(submission, q);
  if (fuzzy) return { correct: true, tier: 2, aiUsed: false };

  // Unresolved: tiers 1–2 say "no", which is exactly where they're weakest
  // (paraphrase). Spend an AI call if the round still has budget.
  if (aiAvailable() && budget && budget.left > 0) {
    budget.left -= 1;
    // Retry a timed-out/failed call before giving up — a transient blip must not
    // silently stamp a genuinely-correct answer WRONG.
    let verdict = null;
    for (let attempt = 0; attempt <= AI_RETRIES && verdict === null; attempt++) {
      verdict = await tier3(submission, q);
    }
    if (verdict === true) {
      // Tier 3 caught a phrasing tiers 1–2 missed — offer it to the admin page
      // so tier 1 catches it for free next time, once approved.
      try { Questions.suggestAltAnswer(q.id, submission); } catch (e) {}
      return { correct: true, tier: 3, aiUsed: true };
    }
    if (verdict === false) return { correct: false, tier: 3, aiUsed: true };
    // null → AI unavailable/errored; fall through to the tier-2 verdict.
    return { correct: false, tier: 2, aiUsed: true, aiFailed: true };
  }
  return { correct: false, tier: 2, aiUsed: false };
}

// ─── public: invent a believable WRONG answer ───
//
// Powers the answer screen's "Give me one" rescue. Runs on a tighter clock than
// the judge: this one fires mid-phase with the answer timer visibly ticking, so
// a slow model is worse than no model — the caller has curated decoys to fall
// back on and uses them the moment this returns null.
//
// The result is NOT trusted. A model asked for a wrong answer will occasionally
// hand back the right one, so the caller re-judges whatever comes out of here
// before showing it to anybody.
const INVENT_MODEL = 'gpt-4o-mini';
const INVENT_TIMEOUT_MS = 3000;

async function inventWrongAnswer(q, avoid = []) {
  if (!aiAvailable()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVENT_TIMEOUT_MS);
  try {
    const lines = [
      'Trivia question: ' + q.question,
      'The REAL answer is: ' + q.answer,
      '',
      'Invent ONE believable but FALSE answer to this question.',
      'Rules:',
      '- It must NOT be the real answer, or a rewording of it.',
      '- Match the real answer in length and grammatical form.',
      '- Prefer a genuine Friends detail that simply is not the answer here.',
      '- No quotation marks, no explanation, no trailing period.'
    ];
    if (avoid.length) lines.push('- Do not use any of these: ' + avoid.join(' / '));
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: INVENT_MODEL,
        max_tokens: 40,
        temperature: 1,          // variety is the whole reason this isn't just a decoy
        messages: [
          { role: 'system', content: 'You write plausible wrong answers for a Friends trivia party game. Reply with the answer only.' },
          { role: 'user', content: lines.join('\n') }
        ]
      })
    });
    if (!r.ok) {
      console.warn('[invent] OpenAI', r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const data = await r.json();
    let text = (data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content || '').trim();
    // Models like to wrap a one-line answer in quotes and end it with a period
    // however firmly you ask them not to.
    text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\.$/, '').trim();
    if (!text || text.length > 120) return null;
    return text;
  } catch (e) {
    console.warn('[invent] unavailable:', e.name === 'AbortError' ? 'timed out' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── public: is this crafted lie too close to the truth? ───
// Runs the same funnel: if the "lie" would have judged as a correct answer,
// it's really the truth and must not join the ballot.
async function isTooCloseToTruth(text, q, budget) {
  const r = await judgeAnswer(text, q, budget);
  return r.correct;
}

// ─── public: do two ballot entries say the same thing? ───
// Tiers 1–2 only — merging is cosmetic and must be instant. Two players who
// guess the same wrong thing share one entry and split its vote credit.
function sameAnswer(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const budget = na.length <= EXACT_ONLY_CHARS ? 0
    : na.length <= SHORT_ANSWER_CHARS ? 1
    : Math.max(1, Math.floor(na.length / 8));
  if (editDistance(na, nb) <= budget) return true;

  // Containment: every key word of the shorter entry appears in the longer one
  // ("fell asleep" inside "fell asleep during it"). Requiring the shorter side
  // to carry at least two key words is what stops "Chandler" being swallowed
  // by "Chandler and Joey" — those are different guesses, not one.
  const ta = tokens(a);
  const tb = tokens(b);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length >= 2) {
    const longSet = new Set(long);
    const hit = short.filter((t) => longSet.has(t)).length;
    if (hit === short.length) return true;
    if (hit / long.length >= 0.8) return true;
  }
  return false;
}

function newRoundBudget() { return { left: AI_CALLS_PER_ROUND }; }

module.exports = {
  judgeAnswer,
  inventWrongAnswer,
  isTooCloseToTruth,
  sameAnswer,
  normalize,
  newRoundBudget,
  aiAvailable,
  // exported for tests
  _tier1: tier1,
  _tier2: tier2
};
