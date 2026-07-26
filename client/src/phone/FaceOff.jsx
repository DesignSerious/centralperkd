import React, { useEffect, useState } from 'react';
import { sendAction } from '../lib/socket';
import { useCountdown } from '../lib/useCountdown';
import PieceVisual from '../lib/PieceVisual';
import * as sfx from '../lib/sfx';

// FACE_OFF: two or more pieces reached the couch in the same round, so nobody
// is handed the game on a tiebreak. Sudden death between them — one question,
// no bluffing, no voting, fastest correct answer wins.
//
// The screen serves both audiences. Finalists get the input; everyone else gets
// the same three beats as a spectator, because the face-off IS the finale and
// watching it is the point.
//
// Note the verdict is NOT on the submit ack (see submitFaceOffAnswer). A
// finalist who locked in knows only that they locked in — the result card is
// where the room finds out together.
export default function FaceOff({ snap }) {
  const fo = snap.faceOff;
  const me = snap.me;
  const mine = !!snap.iAmFinalist;
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(!!snap.myFaceOffAnswer);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const seconds = useCountdown(snap.phaseEndsAt);

  const phase = fo ? fo.phase : 'intro';

  // A new leg means a new question: clear the box so the previous answer isn't
  // sitting there, and let the player type again.
  useEffect(() => {
    setText('');
    setSubmitted(false);
    setError('');
  }, [fo && fo.leg]);

  // Tension for the answer phase only. Stopped on unmount as well as on the
  // phase change, or it would keep thumping under the game-over screen.
  useEffect(() => {
    if (phase !== 'answer') return undefined;
    sfx.heartbeat();
    return () => sfx.heartbeatStop();
  }, [phase, fo && fo.leg]);

  useEffect(() => {
    if (phase === 'intro') sfx.bluffPhase();
    if (phase === 'result') sfx.revealDefinition();
  }, [phase, fo && fo.leg]);

  if (!fo) return null;

  const finalists = fo.playerIds
    .map((id) => snap.players.find((p) => p.id === id))
    .filter(Boolean);

  function submit(e) {
    if (e) e.preventDefault();
    if (busy || submitted) return;
    const clean = text.trim();
    if (!clean) { setError('Anything is better than nothing. Guess.'); return; }
    setError('');
    setBusy(true);
    sendAction('submitFaceOffAnswer', { text: clean }).then((r) => {
      setBusy(false);
      if (!r || !r.ok) { setError((r && r.error) || 'Could not submit.'); return; }
      setSubmitted(true);
      sfx.voteLockedDing();
    });
  }

  // ─── intro ───
  if (phase === 'intro') {
    return (
      <div className="phone-shell cutscene-page-shell">
        <div className="phone-header">
          <div className="eyebrow">☕ Face-off</div>
        </div>
        <div className="phone-status cutscene-page-stage">
          <div className="cutscene-page-headline">
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
            <span>{mine ? 'You made the couch' : 'Dead heat'}</span>
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          </div>
          <FinalistRow finalists={finalists} meId={me && me.id} />
          <div className="cutscene-page-sub">
            {mine
              ? 'So did ' + (finalists.length === 2 ? 'someone else' : (finalists.length - 1) + ' others') +
                '. Sudden death: one question, fastest right answer takes the game.'
              : 'They reached the couch together. Sudden death decides it — fastest right answer wins.'}
          </div>
          <div className="cutscene-page-divider" aria-hidden="true"><span>✦</span></div>
        </div>
      </div>
    );
  }

  // ─── result ───
  if (phase === 'result' && fo.result) {
    const res = fo.result;
    const won = res.winnerId && me && res.winnerId === me.id;
    return (
      <div className="phone-shell">
        <div className="phone-header">
          <div className="eyebrow">☕ Face-off — question {res.leg}</div>
          <div className="word-help">
            {res.winnerId
              ? (won ? 'You took it.' : nameOf(finalists, res.winnerId) + ' took it.')
              : res.again ? 'Nobody got it. Going again…' : 'Nobody got it.'}
          </div>
        </div>
        <div className="phone-question">{res.question}</div>
        <div className="cutscene-page-stage">
          <div className="cutscene-page-sub">The answer was</div>
          <div className="phone-answer-echo">{res.truth}</div>
        </div>
        <div className="phone-stack">
          {res.rows.map((row) => (
            <ResultRow
              key={row.playerId}
              row={row}
              player={finalists.find((p) => p.id === row.playerId)}
              isWinner={row.playerId === res.winnerId}
            />
          ))}
        </div>
      </div>
    );
  }

  // ─── answer ───
  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">☕ Face-off — question {fo.leg}</div>
        <div className="word-help">
          {!mine
            ? 'Sudden death. Fastest right answer takes the game.'
            : submitted
              ? 'Locked in. No hints until the reveal.'
              : 'Type the real answer. Speed is the tiebreak — if you both get it, the faster one wins.'}
        </div>
        {seconds != null && (
          <div className={'timer ' + (seconds < 8 ? 'urgent' : '')}>
            {seconds}<span className="timer-suffix">s</span>
          </div>
        )}
      </div>

      <div className="phone-question">{snap.question && snap.question.question}</div>

      {!mine ? (
        <div className="cutscene-page-stage">
          <FinalistRow
            finalists={finalists}
            meId={me && me.id}
            doneIds={fo.answeredPlayerIds || []}
          />
          <div className="cutscene-page-sub">Eyes on the TV.</div>
        </div>
      ) : submitted ? (
        <div className="cutscene-page-stage">
          <div className="cutscene-page-headline">
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
            <span>Locked in</span>
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          </div>
          <div className="phone-answer-echo">{text || snap.myFaceOffAnswer}</div>
          <div className="cutscene-page-sub">Hold your breath.</div>
        </div>
      ) : (
        <form onSubmit={submit} className="phone-stack">
          <input
            className="lp-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer"
            maxLength={120}
            autoFocus
            autoCapitalize="sentences"
          />
          {error && <div className="error">{error}</div>}
          <button className="lp-btn" type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Locking in…' : 'Lock it in'}
          </button>
        </form>
      )}
    </div>
  );
}

function nameOf(players, id) {
  const p = players.find((x) => x.id === id);
  return p ? p.name : 'They';
}

function FinalistRow({ finalists, meId, doneIds }) {
  return (
    <div className="faceoff-row">
      {finalists.map((p, i) => (
        <React.Fragment key={p.id}>
          {i > 0 && <span className="faceoff-vs">vs</span>}
          <span className={'faceoff-player' + (p.id === meId ? ' is-me' : '')}>
            <PieceVisual id={p.piece} size={40} />
            <span className="faceoff-name">{p.name}</span>
            {doneIds && doneIds.includes(p.id) && <span className="faceoff-tick">✓</span>}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// One finalist's sudden-death answer, with the clock that decided it. The time
// is shown even on a losing correct answer — "you were right, 0.4s late" is the
// whole story of the round and hiding it would be a cheat.
function ResultRow({ row, player, isWinner }) {
  return (
    <div className={'faceoff-result' + (isWinner ? ' is-winner' : '') + (row.correct ? ' is-correct' : '')}>
      <span className="faceoff-result-piece"><PieceVisual id={player && player.piece} size={34} /></span>
      <span className="faceoff-result-body">
        <span className="faceoff-result-name">{player ? player.name : '—'}</span>
        <span className="faceoff-result-answer">{row.text || 'no answer'}</span>
      </span>
      <span className="faceoff-result-mark">
        {row.correct ? '✓' : '✗'}
        {row.ms != null && <span className="faceoff-result-ms">{(row.ms / 1000).toFixed(1)}s</span>}
      </span>
    </div>
  );
}
