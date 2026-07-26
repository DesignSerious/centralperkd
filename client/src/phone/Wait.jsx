import React from 'react';
import { sendAction } from '../lib/socket';
import PieceVisual from '../lib/PieceVisual';

// Held moments where the phone is informational rather than interactive.
//   'round-intro'   next round spinning up (may include the duel pick)
//   'judging'       your answer is in and the judge is still on it. Held apart
//                   from 'answered' so the ~1s AI call reads as "checking",
//                   not as the room waiting on somebody else.
//   'answered'      your answer is in, others are still typing
//   'bluff-wait'    you got it WRONG — others who were right are writing lies.
//                   Shows how MANY knew it, never who: naming them would tell
//                   you which ballot entries are safe to ignore.
//   'vote-wait'     you got it RIGHT — you don't vote; watch who bites
export default function Wait({ snap, mode }) {
  if (mode === 'round-intro') return <RoundIntro snap={snap} />;

  const headline =
    mode === 'judging' ? 'Checking your answer'
      : mode === 'answered' ? 'Answer locked in'
        : mode === 'bluff-wait' ? 'Answers are in'
          : 'You knew it';
  const sub =
    mode === 'judging' ? 'Hang on one second…'
      : mode === 'answered' ? 'Waiting for everyone else to answer…'
        : mode === 'bluff-wait'
          ? (snap.correctCount === 1
              ? '1 player knew the real answer — and is writing a lie about it right now.'
              : snap.correctCount > 1
                ? snap.correctCount + ' players knew the real answer — they\'re writing lies right now.'
                : 'Nobody got it. The ballot is all honest guesses.')
          : 'You already banked the points, so you sit out the vote. Watch who falls for your lie.';

  return (
    <div className="phone-shell cutscene-page-shell">
      <div className="phone-header">
        <div className="eyebrow">{snap.question ? snap.question.category : 'Hold tight'}</div>
      </div>
      <div className="phone-status cutscene-page-stage">
        <div className="cutscene-page-headline">
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          <span>{headline}</span>
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
        </div>
        <div className="cutscene-page-sub">{sub}</div>
        <div className="cutscene-page-divider" aria-hidden="true"><span>✦</span></div>
      </div>
    </div>
  );
}

// ROUND_INTRO doubles as the duel-pick moment: whoever landed on a duel tile
// last round chooses their rival here, while everyone else just sees the
// round card. Auto-resolves server-side if they dawdle.
function RoundIntro({ snap }) {
  if (snap.mustPickDuel) {
    const rivals = snap.players.filter((p) => p.id !== snap.me.id && p.connected);
    return (
      <div className="phone-shell">
        <div className="phone-header">
          <div className="eyebrow">⚡ You landed on a duel</div>
          <div className="word-help">Pick who you're taking on. Next round is scored between the two of you — the higher scorer takes 2 spaces off the other.</div>
        </div>
        <div className="phone-stack">
          {rivals.map((p) => (
            <button
              key={p.id}
              className="vote-choice"
              onClick={() => sendAction('pickDuelOpponent', { opponentId: p.id })}
            >
              <span className="letter"><PieceVisual id={p.piece} size={34} /></span>
              <span className="text">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const duel = snap.duel;
  const a = duel && snap.players.find((p) => p.id === duel.challengerId);
  const b = duel && snap.players.find((p) => p.id === duel.opponentId);
  return (
    <div className="phone-shell cutscene-page-shell">
      <div className="phone-header">
        <div className="eyebrow">Round {snap.round}</div>
      </div>
      <div className="phone-status cutscene-page-stage">
        <div className="cutscene-page-headline">
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          <span>{snap.question ? snap.question.category : 'Next question'}</span>
          <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
        </div>
        <div className="cutscene-page-sub">
          {duel && a && b
            ? '⚡ Duel: ' + a.name + ' vs ' + b.name
            : snap.me && snap.me.doubleNext
              ? '☕ Your next correct answer pays double.'
              : 'Eyes on the TV.'}
        </div>
        <div className="cutscene-page-divider" aria-hidden="true"><span>✦</span></div>
      </div>
    </div>
  );
}
