// End-to-end smoke test for the answer-first bluff loop. Two parts:
//
//   Part A — a TV + 3 phones play live rounds: one player types the REAL
//            answer, one types a wrong guess, one says nothing. Checks the
//            phase order, that the right player is routed to BLUFFING and the
//            wrong one to VOTING, that no client is ever told which ballot
//            entry is the truth, and that the scoring maths lands.
//   Part B — a bot-simulated game runs to GAME_OVER with a winner on the line.
//
// Usage:  node server/index.js                                  (terminal 1)
//         BASE=http://localhost:3000 node scripts/smoke-test.js (terminal 2)
//
// Part A needs to know the real answer to make one player right on purpose.
// The server never tells a client that, so the harness reads questions.json
// directly — a test-harness privilege, not something a client could do.

const { io } = require('socket.io-client');
const BANK = require('../server/questions.json');

const BASE = process.env.BASE || 'http://localhost:3000';
const EXPECTED_ORDER = ['ROUND_INTRO', 'ANSWERING', 'BLUFFING', 'VOTING', 'REVEAL', 'SCORING'];

function log(label, ...rest) { console.log('[' + label + ']', ...rest); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitFor(pred, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v = null;
      try { v = pred(); } catch (e) {}
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for ' + what));
      setTimeout(tick, 40);
    };
    tick();
  });
}

let failures = 0;
function check(ok, msg) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) failures += 1;
}

function answerFor(questionText) {
  const q = (Array.isArray(BANK) ? BANK : BANK.questions).find((x) => x.question === questionText);
  return q ? q.answer : null;
}

async function partA() {
  console.log('\n=== PART A — live round: one right, one wrong, one silent ===');
  const tv = io(BASE, { transports: ['websocket'] });
  const phones = [0, 1, 2].map(() => io(BASE, { transports: ['websocket'] }));
  let tvState = null;
  const pState = [null, null, null];
  tv.on('state', (d) => { tvState = d; });
  phones.forEach((s, i) => s.on('state', (d) => { pState[i] = d; }));

  const created = await new Promise((r) => tv.emit('tv:create', (res) => r(res)));
  if (!created || !created.ok) throw new Error('TV could not create a room');
  log('TV', 'room', created.code);

  const names = ['Knower', 'Guesser', 'Silent'];
  const pieces = ['lantern', 'ufo', 'compass'];
  for (let i = 0; i < 3; i++) {
    const res = await new Promise((r) => phones[i].emit('player:join',
      { code: created.code, name: names[i], piece: pieces[i] }, (x) => r(x)));
    if (!res || !res.ok) throw new Error('join failed for ' + names[i] + ': ' + (res && res.error));
  }
  await waitFor(() => tvState && tvState.players.length === 3, 5000, '3 players in lobby');

  console.log('\n— lobby —');
  const dupe = await new Promise((r) => phones[0].emit('player:join',
    { code: created.code, name: 'Dupe', piece: 'ufo' }, (x) => r(x)));
  check(dupe && !dupe.ok, 'a taken piece is rejected');
  check(Array.isArray(tvState.allCategories) && tvState.allCategories.length >= 5,
    'lobby sees the bank categories (' + (tvState.allCategories || []).length + ')');

  await new Promise((r) => tv.emit('action', { type: 'updateSettings',
    data: { boardSpaces: 16, answerSeconds: 20, bluffSeconds: 15, voteSeconds: 20 } }, r));
  await waitFor(() => tvState.settings.boardSpaces === 16, 4000, 'settings applied');
  check(tvState.board.length === 17, 'board rebuilt (17 entries: START + 15 + FINISH)');
  check(tvState.board.some((s) => s.type === 'bonus')
     && tvState.board.some((s) => s.type === 'advance'), 'board carries bonus / advance tiles');
  check(tvState.settings.allowUnverified === true,
    'unverified questions allowed by default (starter bank is all verified:false)');

  await new Promise((r) => tv.emit('action', { type: 'startGame' }, r));

  const seen = [];
  let last = null;
  let rounds = 0;
  let acted = -1;
  let didPrivacy = false;
  let didReveal = false;
  let didVoteChecks = false;
  let realAnswer = null;
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline && rounds <= 2) {
    if (!tvState) { await wait(40); continue; }
    const st = tvState.state;
    if (st !== last) {
      last = st;
      if (st === 'ROUND_INTRO') { rounds += 1; acted = -1; }
      if (rounds <= 1) seen.push(st);
      log('PHASE', st + (st === 'ROUND_INTRO' ? ' (round ' + tvState.round + ')' : ''));
    }

    // ANSWERING: phone 0 types the truth, phone 1 a wrong guess, phone 2 nothing.
    if (st === 'ANSWERING' && acted !== rounds && tvState.question) {
      acted = rounds;
      realAnswer = answerFor(tvState.question.question);
      if (!realAnswer) throw new Error('could not resolve the answer for: ' + tvState.question.question);

      if (!didPrivacy) {
        didPrivacy = true;
        console.log('\n— privacy during ANSWERING —');
        check(!tvState.truth, 'TV snapshot carries no truth');
        check(!tvState.ballot || !tvState.ballot.length, 'no ballot exists yet');
        check(pState[0] && !pState[0].truth, 'phone snapshot carries no truth');
        check(pState[0] && pState[0].question && pState[0].question.answer === undefined,
          'the question payload has no answer field');
      }

      const r0 = await new Promise((r) => phones[0].emit('action',
        { type: 'submitAnswer', data: { text: realAnswer } }, (x) => r(x)));
      const r1 = await new Promise((r) => phones[1].emit('action',
        { type: 'submitAnswer', data: { text: 'a completely made up thing' } }, (x) => r(x)));
      if (!didReveal) {
        console.log('\n— judging —');
        check(r0 && r0.ok && r0.correct === true, 'the real answer judged CORRECT');
        check(r1 && r1.ok && r1.correct === false, 'the made-up answer judged WRONG');
        const dup = await new Promise((r) => phones[0].emit('action',
          { type: 'submitAnswer', data: { text: 'second try' } }, (x) => r(x)));
        check(dup && dup.ok === false, 'a second answer from the same phone is refused');
      }
    }

    // BLUFFING: only the correct player may write.
    if (st === 'BLUFFING' && pState[0]) {
      if (!didReveal && pState[0].canBluff) {
        console.log('\n— bluffing —');
        check(pState[0].myAnswerCorrect === true, 'right player is told they were right');
        check(pState[1] && pState[1].myAnswerCorrect === false, 'wrong player is told they missed');
        check(pState[1] && !pState[1].canBluff, 'wrong player cannot write a lie');
        const tooClose = await new Promise((r) => phones[0].emit('action',
          { type: 'submitBluff', data: { text: realAnswer } }, (x) => r(x)));
        check(tooClose && tooClose.ok === false, 'a "lie" that is really the truth is rejected');
        const ok = await new Promise((r) => phones[0].emit('action',
          { type: 'submitBluff', data: { text: 'Gunther did it, obviously' } }, (x) => r(x)));
        check(ok && ok.ok === true, 'a genuine lie is accepted');
      }
    }

    // VOTING: only the wrong player votes.
    // Guarded: these assertions describe the state BEFORE the vote is cast,
    // so they must run exactly once — re-checking after voting would (rightly)
    // see canVote flip to false.
    if (st === 'VOTING' && !didVoteChecks && pState[1] && pState[1].ballot && pState[1].ballot.length) {
      didVoteChecks = true;
      {
        console.log('\n— voting —');
        check(pState[0].canVote === false, 'the player who knew it does NOT vote');
        check(pState[1].canVote === true, 'the player who missed it DOES vote');
        const marked = pState[1].ballot.some((b) => b.isTruth !== undefined);
        check(!marked, 'the voting ballot never marks which entry is real');
        check((pState[1].myBallotLetters || []).length >= 1, 'voter sees which entry is their own');
        // Vote for the truth on purpose so the scoring branch is exercised.
        const truthLetter = pState[1].ballot.find((b) => b.text.toLowerCase() === realAnswer.toLowerCase());
        const pick = truthLetter || pState[1].ballot.find((b) => !(pState[1].myBallotLetters || []).includes(b.letter));
        if (pick) phones[1].emit('action', { type: 'vote', data: { letter: pick.letter } });
      }
    }

    if (st === 'REVEAL' && !didReveal && tvState.lastResults && Object.keys(tvState.lastResults).length) {
      didReveal = true;
      console.log('\n— reveal + scoring —');
      check(!!tvState.truth, 'TV learns the truth at REVEAL: "' + tvState.truth + '"');
      const truthEntry = (tvState.ballot || []).find((b) => b.isTruth);
      check(!!truthEntry, 'the ballot is now marked with the truth');
      const byName = {};
      for (const p of tvState.players) byName[p.name] = tvState.lastResults[p.id] || {};
      check(byName.Knower.correct === true, 'Knower scored correct');
      check(byName.Guesser.correct === false, 'Guesser scored wrong');
      check(byName.Silent.answered === false, 'Silent never answered');
      check(byName.Knower.fromAnswer === 3, 'knowing it pays 3 (got ' + byName.Knower.fromAnswer + ')');
      check(byName.Silent.spaces === 0, 'no answer, no movement');
      check(tvState.settings.pointsCorrectAnswer !== tvState.settings.pointsFoundTruth,
        'knowing it and guessing well pay DIFFERENT amounts (else the board never separates)');
    }

    await wait(40);
  }

  console.log('\n— phase order —');
  check(EXPECTED_ORDER.every((s, i) => seen[i] === s),
    'round 1 ran ' + EXPECTED_ORDER.join(' → ') + '\n         (saw ' + seen.slice(0, 6).join(' → ') + ')');

  tv.emit('action', { type: 'abortToLobby' });
  await wait(200);
  tv.close();
  phones.forEach((s) => s.close());
}

async function partB() {
  console.log('\n=== PART B — bot simulation to GAME_OVER ===');
  const tv = io(BASE, { transports: ['websocket'] });
  let tvState = null;
  tv.on('state', (d) => { tvState = d; });
  const created = await new Promise((r) => tv.emit('tv:create', (res) => r(res)));
  log('TV', 'room', created.code);
  const sim = await new Promise((r) => tv.emit('tv:simulate', (res) => r(res)));
  check(sim && sim.ok, 'simulation started (4 CPU players)');

  let rounds = 0;
  let last = null;
  const phases = new Set();
  // Nothing in the default rules may move a piece backwards. Sampling every
  // snapshot catches a regression anywhere in scoring, tiles or duels.
  const lastPos = {};
  let regressions = 0;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (tvState) {
      for (const p of tvState.players) {
        if (lastPos[p.id] !== undefined && p.position < lastPos[p.id]) {
          regressions += 1;
          console.log('    ! ' + p.name + ' moved BACKWARD ' + lastPos[p.id] + ' -> ' + p.position);
        }
        lastPos[p.id] = p.position;
      }
    }
    if (tvState && tvState.state !== last) {
      last = tvState.state;
      phases.add(last);
      if (last === 'ROUND_INTRO') rounds += 1;
      if (last === 'GAME_OVER') break;
    }
    await wait(60);
  }

  console.log('\n— completion —');
  check(tvState && tvState.state === 'GAME_OVER', 'reached GAME_OVER after ' + rounds + ' rounds');
  check(phases.has('BLUFFING'), 'bots exercised the BLUFFING phase');
  check(phases.has('VOTING'), 'bots exercised the VOTING phase');
  const winner = tvState && tvState.players.find((p) => p.id === tvState.winnerId);
  check(regressions === 0, 'no piece ever moved backwards (' + regressions + ' regressions)');
  check(!!winner, 'a winner is named: ' + (winner ? winner.name : '(none)'));
  check(!!winner && winner.position >= tvState.settings.boardSpaces,
    'winner reached FINISH (' + (winner && winner.position) + '/' + (tvState && tvState.settings.boardSpaces) + ')');
  console.log('  final: ' + tvState.players
    .map((p) => p.name + ' ' + p.position + ' (' + p.correct + '✓, fooled ' + p.fooled + ')').join(', '));
  tv.close();
}

(async function main() {
  await partA();
  await partB();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nSMOKE TEST ERROR:', e.message);
  process.exit(1);
});
