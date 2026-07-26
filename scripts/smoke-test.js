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
  let didEarlyBluff = false;
  let didEarlySurvived = false;
  let didEarlyBallot = false;
  let didRescue = false;
  let realAnswer = null;
  const EARLY_LIE = 'Marcel the monkey confessed on tape';
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

      // Round 1 also covers the answer-screen rescue. Phone 2 is the silent
      // player, so it can burn both of its "Give me one" uses without disturbing
      // the round the other two assertions depend on.
      if (rounds === 1 && !didRescue) {
        didRescue = true;
        console.log('\n— give me one —');
        check(pState[2].rescuesLeft === 2, 'a player starts the game with 2 uses');
        const one = await new Promise((r) => phones[2].emit('action',
          { type: 'rescueAnswer' }, (x) => r(x)));
        check(one && one.ok === true && !!one.text, 'the button hands back an answer: "' + (one && one.text) + '"');
        check(one.rescuesLeft === 1, 'using one leaves 1');
        // The whole point of this button is that it does NOT score you points.
        // An invented answer that lands on the truth would make it free spaces.
        check(Judge.normalize(one.text) !== Judge.normalize(realAnswer),
          'the suggestion is NOT the real answer');
        const two = await new Promise((r) => phones[2].emit('action',
          { type: 'rescueAnswer' }, (x) => r(x)));
        check(two && two.ok === true && !!two.text, 'a second use is allowed');
        check(Judge.normalize(two.text) !== Judge.normalize(one.text),
          'the second suggestion is a different one');
        check(two.rescuesLeft === 0, 'using the second leaves 0');
        const three = await new Promise((r) => phones[2].emit('action',
          { type: 'rescueAnswer' }, (x) => r(x)));
        check(three && three.ok === false, 'a third use is refused');
        await waitFor(() => pState[2] && pState[2].rescuesLeft === 0, 4000, 'count pushed to the phone');
        // Nobody else's allowance moved, and no snapshot names who reached for one.
        check(pState[0].rescuesLeft === 2, "another player's allowance is untouched");
        check(tvState.players.every((p) => p.rescuesLeft === undefined),
          'the TV is never told who used a rescue');
      }

      // Round 2 covers the EARLY bluff path: a player cleared by the judge
      // writes their lie while ANSWERING is still running, instead of waiting
      // for the phase to close. Round 1 above already covered the classic
      // wait-for-BLUFFING path, so both routes are exercised.
      if (rounds === 2 && !didEarlyBluff) {
        didEarlyBluff = true;
        console.log('\n— early bluff (still in ANSWERING) —');
        await waitFor(() => pState[0] && pState[0].canBluff, 8000, 'right player handed the lie screen');
        check(tvState.state === 'ANSWERING', 'still in ANSWERING when the bluff window opens');
        check(pState[0].myAnswerCorrect === true, 'right player is told they were right immediately');
        check(!(pState[1] && pState[1].canBluff), 'wrong player gets no early bluff window');
        // The whole table can see the TV. It must not name who got it right
        // while the others are still typing their answers.
        check(!tvState.bluffedPlayerIds || !tvState.bluffedPlayerIds.length,
          'TV is not told who has already written a lie');
        check(!tvState.correctCount, 'TV is not told how many got it right yet');
        const early = await new Promise((r) => phones[0].emit('action',
          { type: 'submitBluff', data: { text: EARLY_LIE } }, (x) => r(x)));
        check(early && early.ok === true, 'a lie submitted during ANSWERING is accepted');
        await waitFor(() => pState[0] && pState[0].myBluff === EARLY_LIE, 4000, 'early lie echoed back');
        check(tvState.state === 'ANSWERING', 'the early lie did NOT pull the room out of ANSWERING');
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
      // Round 2: the lie was written back in ANSWERING. Entering BLUFFING must
      // not wipe it, and the writer must not be asked for a second one.
      if (didEarlyBluff && !didEarlySurvived) {
        didEarlySurvived = true;
        console.log('\n— early bluff survives the phase change —');
        check(pState[0].myBluff === EARLY_LIE, 'the early lie is still held at BLUFFING');
        check(pState[0].canBluff === false, 'the early writer is not asked to lie again');
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

    // Round 2's ballot must carry the lie that was written back in ANSWERING —
    // the point of the whole early-bluff path.
    if (st === 'VOTING' && didEarlySurvived && !didEarlyBallot
        && pState[1] && pState[1].ballot && pState[1].ballot.length) {
      didEarlyBallot = true;
      console.log('\n— early bluff reaches the ballot —');
      check(pState[1].ballot.some((b) => b.text === EARLY_LIE),
        'the lie written during ANSWERING is on the ballot');
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

// ─── PART C — two pieces reach the couch together, so they play for it ───
//
// Deterministic by construction: TWO phones, both of which answer every question
// correctly. With nobody left to fool, each round takes the "everyone knew it"
// path straight to the reveal, both players bank the same 3 spaces, and they
// walk the 16-space board in lockstep — arriving on the couch on the same round.
// That is exactly the collision that used to be settled by a hidden sort.
//
// The face-off itself is then driven through BOTH of its branches: leg 1 has
// both finalists answer wrong (nobody wins, the room goes again) and leg 2 has
// both answer right, with a deliberate delay on one so the speed tiebreak is
// what decides the game.
async function partC() {
  console.log('\n=== PART C — couch face-off (two pieces arrive together) ===');
  const tv = io(BASE, { transports: ['websocket'] });
  const phones = [0, 1].map(() => io(BASE, { transports: ['websocket'] }));
  let tvState = null;
  const pState = [null, null];
  tv.on('state', (d) => { tvState = d; });
  phones.forEach((s, i) => s.on('state', (d) => { pState[i] = d; }));

  const created = await new Promise((r) => tv.emit('tv:create', (res) => r(res)));
  if (!created || !created.ok) throw new Error('TV could not create a room');
  log('TV', 'room', created.code);

  const names = ['Racer', 'Chaser'];
  for (let i = 0; i < 2; i++) {
    const res = await new Promise((r) => phones[i].emit('player:join',
      { code: created.code, name: names[i], piece: ['lantern', 'ufo'][i] }, (x) => r(x)));
    if (!res || !res.ok) throw new Error('join failed for ' + names[i] + ': ' + (res && res.error));
  }
  await waitFor(() => tvState && tvState.players.length === 2, 5000, '2 players in lobby');

  await new Promise((r) => tv.emit('action', { type: 'updateSettings',
    data: { boardSpaces: 16, answerSeconds: 20, bluffSeconds: 15, voteSeconds: 20 } }, r));
  await waitFor(() => tvState.settings.boardSpaces === 16, 4000, 'settings applied');
  await new Promise((r) => tv.emit('action', { type: 'startGame' }, r));

  // Race to the couch: both phones answer every question correctly.
  const answeredIn = new Set();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && tvState.state !== 'FACE_OFF' && tvState.state !== 'GAME_OVER') {
    if (tvState.state === 'ANSWERING' && tvState.question && !answeredIn.has(tvState.round)) {
      answeredIn.add(tvState.round);
      const truth = answerFor(tvState.question.question);
      if (!truth) throw new Error('could not resolve the answer for: ' + tvState.question.question);
      await Promise.all(phones.map((s) => new Promise((r) =>
        s.emit('action', { type: 'submitAnswer', data: { text: truth } }, (x) => r(x)))));
    }
    await wait(60);
  }

  console.log('\n— arrival —');
  check(tvState.state === 'FACE_OFF',
    'two pieces on the couch triggered a FACE_OFF (state: ' + tvState.state + ')');
  if (tvState.state !== 'FACE_OFF') { tv.close(); phones.forEach((s) => s.close()); return; }
  check(tvState.players.every((p) => p.position >= 16), 'both pieces are ON the couch');
  check(!!tvState.faceOff && tvState.faceOff.playerIds.length === 2, 'both players are finalists');
  check(tvState.faceOff.phase === 'intro', 'the face-off opens on its intro card');
  check(pState[0].iAmFinalist === true && pState[1].iAmFinalist === true,
    'both phones are told they are in it');

  // ── leg 1: both wrong, so nobody takes it and the room goes again ──
  await waitFor(() => tvState.faceOff && tvState.faceOff.phase === 'answer', 12000, 'leg 1 question');
  console.log('\n— leg 1: nobody gets it —');
  check(tvState.faceOff.leg === 1, 'leg counter starts at 1');
  check(!tvState.truth, 'the TV is not told the answer during the face-off');
  check(pState[0].canFaceOff === true, 'a finalist may answer');
  const wrong0 = await new Promise((r) => phones[0].emit('action',
    { type: 'submitFaceOffAnswer', data: { text: 'a wrong sudden death guess' } }, (x) => r(x)));
  check(wrong0 && wrong0.ok === true, 'a face-off answer is accepted');
  check(wrong0.correct === undefined, 'the ack does NOT leak the verdict (that is the reveal)');
  const dup = await new Promise((r) => phones[0].emit('action',
    { type: 'submitFaceOffAnswer', data: { text: 'second try' } }, (x) => r(x)));
  check(dup && dup.ok === false, 'a second face-off answer from the same phone is refused');
  await new Promise((r) => phones[1].emit('action',
    { type: 'submitFaceOffAnswer', data: { text: 'also completely wrong' } }, (x) => r(x)));

  await waitFor(() => tvState.faceOff && tvState.faceOff.phase === 'result', 20000, 'leg 1 result');
  check(tvState.faceOff.result.winnerId === null, 'nobody wins a leg where both were wrong');
  check(tvState.faceOff.result.again === true, 'the room is told it is going again');
  check(!!tvState.faceOff.result.truth, 'the result card carries the real answer');

  // ── leg 2: both right, so the CLOCK decides ──
  await waitFor(() => tvState.faceOff && tvState.faceOff.phase === 'answer' && tvState.faceOff.leg === 2,
    20000, 'leg 2 question');
  console.log('\n— leg 2: both right, fastest wins —');
  const truth2 = answerFor(tvState.question.question);
  if (!truth2) throw new Error('could not resolve the leg-2 answer');
  await new Promise((r) => phones[0].emit('action',
    { type: 'submitFaceOffAnswer', data: { text: truth2 } }, (x) => r(x)));
  await wait(1200);                       // Chaser is a second and a bit slower
  await new Promise((r) => phones[1].emit('action',
    { type: 'submitFaceOffAnswer', data: { text: truth2 } }, (x) => r(x)));

  await waitFor(() => tvState.faceOff && tvState.faceOff.phase === 'result', 20000, 'leg 2 result');
  const res = tvState.faceOff.result;
  const racer = tvState.players.find((p) => p.name === 'Racer');
  check(res.rows.every((r) => r.correct), 'both finalists judged correct');
  check(res.winnerId === racer.id, 'the FASTER correct answer won it');
  const times = res.rows.map((r) => r.ms);
  check(times.every((t) => typeof t === 'number'), 'both answers carry a submission time');
  console.log('    ' + res.rows.map((r) =>
    (tvState.players.find((p) => p.id === r.playerId) || {}).name + ' ' +
    (r.ms / 1000).toFixed(1) + 's ' + (r.correct ? '✓' : '✗')).join('  |  '));

  await waitFor(() => tvState.state === 'GAME_OVER', 20000, 'game over');
  console.log('\n— the game is decided —');
  check(tvState.winnerId === racer.id, 'the face-off winner is the game winner');
  tv.close();
  phones.forEach((s) => s.close());
}

// ─── PART D — the coffee cup doubles the WHOLE move ───
//
// The reported bug: a player standing on a coffee cup scored 1 space and the
// tile did nothing, because the multiplier only ever touched the points for
// knowing the answer. It now pays on everything — and, crucially, a round you
// score nothing in must NOT burn it.
//
// Driven through computeResults directly rather than over sockets: getting a
// specific player onto a specific tile and then engineering a votes-only round
// takes a dozen rounds of live play, and the arithmetic is the thing under test.
function partD() {
  console.log('\n=== PART D — coffee-cup scoring ===');
  const Game = require('../server/game');
  const s = {
    pointsCorrectAnswer: 3, pointsPerVote: 2, pointsFoundTruth: 1,
    pointsNobodyFoundTruth: 0, bonusTileMultiplier: 2
  };

  // A room stub with just what computeResults reads.
  function room({ correct, votesFor, foundTruth, doubleNext }) {
    const me = { id: 'me', name: 'Cupholder', doubleNext, correct: 0, fooled: 0, streak: 0, bestStreak: 0 };
    const them = { id: 'them', name: 'Voter', doubleNext: false, correct: 0, fooled: 0, streak: 0, bestStreak: 0 };
    const ballot = [
      { letter: 'A', text: 'the truth', authorIds: [], isTruth: true },
      { letter: 'B', text: 'my guess', authorIds: ['me'], isTruth: false }
    ];
    return {
      settings: s,
      players: [me, them],
      answers: { me: { text: 'x', correct }, them: { text: 'y', correct: false } },
      ballot,
      votes: Object.assign({}, votesFor ? { them: 'B' } : {}, foundTruth ? { me: 'A' } : {}),
      laughs: {}, duelPending: null, lastResults: {}
    };
  }

  // computeResults writes into room.lastResults rather than returning.
  function score(opts) {
    const r = room(opts);
    Game._computeResults(r);
    return { r: r.lastResults.me, doubleNextAfter: r.players[0].doubleNext };
  }

  // The exact round from the bug report: on a cup, answered WRONG, but voted
  // for the real answer. One point, which used to come out as one point.
  const bug = score({ correct: false, votesFor: false, foundTruth: true, doubleNext: true });
  check(bug.r.spaces === 2, 'on a cup: a 1-space found-truth round now pays 2 (was 1)');
  check(bug.r.doubled === true, 'the round is marked as doubled');
  check(bug.doubleNextAfter === false, 'the cup is spent');

  // Knowing it still doubles, as it always did.
  const knew = score({ correct: true, votesFor: false, foundTruth: false, doubleNext: true });
  check(knew.r.spaces === 6, 'on a cup: knowing it still pays 3 x2 = 6');

  // Votes pulled by your entry are doubled too — they never were before.
  const fooled = score({ correct: false, votesFor: true, foundTruth: false, doubleNext: true });
  check(fooled.r.spaces === 4, 'on a cup: a 2-space votes round now pays 4');

  // Everything at once: 3 + 2 + 1 = 6, doubled.
  const all = score({ correct: true, votesFor: true, foundTruth: true, doubleNext: true });
  check(all.r.spaces === 12, 'on a cup: knew it + a vote + found truth = 12');

  // The important guard: score nothing and you KEEP the cup.
  const blank = score({ correct: false, votesFor: false, foundTruth: false, doubleNext: true });
  check(blank.r.spaces === 0, 'a scoreless round pays 0');
  check(blank.doubleNextAfter === true, 'a scoreless round does NOT burn the cup');
  check(blank.r.doubled === false, 'a scoreless round is not marked doubled');

  // And without a cup nothing changes.
  const plain = score({ correct: true, votesFor: true, foundTruth: true, doubleNext: false });
  check(plain.r.spaces === 6, 'without a cup: 3 + 2 + 1 = 6');
  check(plain.r.doubled === false, 'without a cup nothing is marked doubled');
}

(async function main() {
  partD();
  await partA();
  await partB();
  await partC();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nSMOKE TEST ERROR:', e.message);
  process.exit(1);
});
