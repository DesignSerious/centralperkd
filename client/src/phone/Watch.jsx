import React, { useEffect, useRef } from 'react';
import { sendAction } from '../lib/socket';
import PieceVisual from '../lib/PieceVisual';
import * as sfx from '../lib/sfx';

// REVEAL / SCORING / GAME_OVER on the phone.
//
// The TV owns the drama, so this screen deliberately waits: until the server
// says the truth is on the big screen (snap.awaitingReveal), the phone shows a
// holding card. Then it tells the player, in order: what the answer was, what
// they said, what that earned them, and where it put them.
export default function Watch({ snap }) {
  if (snap.state === 'GAME_OVER') return <GameOver snap={snap} />;
  if (snap.awaitingReveal) return <AwaitingReveal snap={snap} />;
  return <Result snap={snap} />;
}

// Shown while the TV builds up to the answer. No verdict, no numbers — giving
// any of it away here would spoil the room's moment.
function AwaitingReveal({ snap }) {
  return (
    <div className="phone-shell cutscene-page-shell">
      <div className="phone-header">
        <div className="eyebrow">{snap.question ? snap.question.category : 'Reveal'}</div>
      </div>
      <div className="phone-status cutscene-page-stage">
        <div className="cutscene-page-headline lp-pulse">
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          <span>Eyes on the TV</span>
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
        </div>
        <div className="cutscene-page-sub">The real answer is about to drop…</div>
        <div className="cutscene-page-divider" aria-hidden="true"><span>✦</span></div>
      </div>
    </div>
  );
}

function Result({ snap }) {
  const r = snap.myResult || {};
  const knewIt = !!r.correct;
  const spaces = r.spaces || 0;

  // One cue on entry. SCORING re-broadcasts (frozen, then positions applied),
  // so this must not re-fire.
  const playedRef = useRef(false);
  useEffect(() => {
    if (playedRef.current) return;
    playedRef.current = true;
    sfx.revealPhone(true, knewIt);
  }, []);

  // Itemize where the movement came from, so "+2" is never a mystery number.
  const lines = [];
  // The coffee cup no longer doubles only the answer points — it doubles every
  // line below it, so the marker belongs on the round, not on one row. Each `v`
  // here is already the doubled figure.
  if (r.fromAnswer) lines.push({ label: 'You knew the answer', v: r.fromAnswer });
  if (r.fromVotes) {
    lines.push({
      label: r.votesPulled === 1 ? '1 player voted for your answer' : r.votesPulled + ' players voted for your answer',
      v: r.fromVotes
    });
  }
  if (r.fromTruth) lines.push({ label: 'You voted for the real answer', v: r.fromTruth });
  if (r.duel === 'won') lines.push({ label: '⚡ You won the duel', v: 2 });
  if (r.duel === 'lost') lines.push({ label: '⚡ You lost the duel', v: -2 });

  // Headline the round as a whole. The old copy stamped a ✕ on anyone who
  // missed the answer even when they'd just fooled half the table and voted
  // correctly — which read as "you failed" on a round they actually did well.
  let headline;
  let tone;
  if (knewIt) {
    headline = 'You knew it!';
    tone = 'is-correct';
  } else if (!r.answered) {
    headline = 'You ran out of time';
    tone = 'is-wrong';
  } else if (spaces > 0) {
    headline = 'You missed it — but you still scored';
    tone = 'is-mixed';
  } else {
    headline = 'Nothing landed this round';
    tone = 'is-wrong';
  }

  const me = snap.me;
  const goal = snap.settings.boardSpaces;

  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">{snap.question ? snap.question.category : 'Result'}</div>
      </div>

      {/* 1. The answer — same thing the TV just showed, so the phone reads as
             a continuation of the room rather than a competing screen. */}
      {snap.truth && (
        <div className="phone-truth">
          <div className="phone-truth-label">The answer was</div>
          <div className="phone-truth-text">{snap.truth}</div>
        </div>
      )}

      {/* 2. What you said about it. */}
      {r.answered && (
        <div className={'phone-yours ' + (knewIt ? 'is-correct' : 'is-wrong')}>
          <span className="mark">{knewIt ? '✓' : '✕'}</span>
          <span className="label">You said</span>
          <span className="text">{r.answerText}</span>
        </div>
      )}

      {/* Dispute: a player judged wrong can ask the table to overturn the ruling.
          Only offered while the truth is up (snap.reviewsOpen, via canRequestReview). */}
      {(snap.canRequestReview || snap.iRequestedReview) && (
        <div className="phone-review-cta">
          {snap.iRequestedReview ? (
            <div className="phone-review-requested">
              <span className="mark" aria-hidden="true">✋</span>
              Review requested — the table votes after the reveal.
            </div>
          ) : (
            <>
              <div className="phone-review-prompt">Think you got it right?</div>
              <button
                type="button"
                className="lp-btn phone-review-request"
                onClick={() => sendAction('requestReview')}
              >
                ✋ Request a Review
              </button>
              <div className="phone-review-hint">The other players vote — majority overturns it and you get the points.</div>
            </>
          )}
        </div>
      )}

      {r.advanced > 0 && (
        <div className="phone-slide-note is-forward">
          → You landed on an <strong>arrow</strong> at space {r.advancedFrom} and
          moved {r.advanced} more to {r.advancedTo}.
        </div>
      )}
      {r.landedBonus && (
        <div className="phone-slide-note is-forward">
          ☕ Coffee-cup tile — your next scoring move is worth double. All of it.
        </div>
      )}

      {snap.skipReason === 'everyone-knew' && (
        <div className="phone-skip-note">
          Everyone got it right, so there was nobody left to fool — no lies or
          voting this round.
        </div>
      )}

      {/* 3. What it earned. */}
      <div className={'phone-result ' + tone}>
        <div className="phone-result-headline">{headline}</div>
        <div className="phone-result-move">
          {spaces > 0 ? '+' + spaces : spaces < 0 ? String(spaces) : '0'}
          <span className="unit">{Math.abs(spaces) === 1 ? 'space' : 'spaces'}</span>
        </div>
      </div>

      {lines.length > 0 && (
        <div className="phone-breakdown">
          {r.doubled && (
            <div className="phone-breakdown-row is-doubled">
              <span>☕ Coffee cup — everything below is multiplied</span>
              <span className="v">×{(snap.settings && snap.settings.bonusTileMultiplier) || 2}</span>
            </div>
          )}
          {lines.map((l) => (
            <div className="phone-breakdown-row" key={l.label}>
              <span>{l.label}</span>
              <span className="v">{l.v > 0 ? '+' + l.v : l.v}</span>
            </div>
          ))}
        </div>
      )}

      {/* 4. Where that puts you. */}
      {me && (
        <div className="phone-progress">
          <span className="emoji"><PieceVisual id={me.piece} size={40} /></span>
          <span className="label">Space {me.position} of {goal}</span>
          <span className="bar"><span className="fill" style={{ width: Math.min(100, (me.position / goal) * 100) + '%' }} /></span>
        </div>
      )}

      <div className="phone-stack" style={{ marginTop: 14 }}>
        {[...snap.players].sort((a, b) => b.position - a.position).map((p) => (
          <div key={p.id} className="score-row">
            <span className="emoji"><PieceVisual id={p.piece} size={40} /></span>
            <span className="name">
              {p.name}
              {p.id === snap.me.id && <span style={{ color: 'var(--gold)', marginLeft: 8, fontSize: '0.85rem' }}>(you)</span>}
            </span>
            <span style={{ color: 'var(--cream-fade)', fontSize: '0.9rem' }}>
              {p.position} / {goal}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GameOver({ snap }) {
  const winner = snap.players.find((p) => p.id === snap.winnerId);
  const iWon = !!(winner && snap.me && winner.id === snap.me.id);
  useEffect(() => { if (iWon) sfx.win(); }, [iWon]);
  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">Game over</div>
      </div>
      <div className="phone-status" style={{ textAlign: 'center' }}>
        {winner && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <PieceVisual id={winner.piece} size={110} glow />
          </div>
        )}
        <div className="cutscene-page-headline" style={{ marginTop: 10 }}>
          {iWon ? 'You win!' : winner ? winner.name + ' wins' : 'That’s a wrap'}
        </div>
        {snap.me && (
          <div className="cutscene-page-sub">
            {snap.me.correct} right · fooled people {snap.me.fooled} times
          </div>
        )}
      </div>

      <div className="phone-stack" style={{ marginTop: 18 }}>
        {[...snap.players].sort((a, b) => b.position - a.position).map((p) => (
          <div key={p.id} className="score-row">
            <span className="emoji"><PieceVisual id={p.piece} size={44} /></span>
            <span className="name">{p.name}</span>
            <span style={{ color: 'var(--cream-fade)', fontSize: '0.9rem' }}>{p.position}</span>
          </div>
        ))}
      </div>

      <button className="lp-btn" style={{ width: '100%', marginTop: 18 }} onClick={() => sendAction('playAgain')}>
        Play again
      </button>
      <button className="lp-btn lp-btn--ghost" style={{ width: '100%', marginTop: 12 }} onClick={() => sendAction('returnToLobby')}>
        Back to lobby
      </button>
    </div>
  );
}
