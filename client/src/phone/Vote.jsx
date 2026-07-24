import React, { useEffect, useRef } from 'react';
import { sendAction } from '../lib/socket';
import { useCountdown } from '../lib/useCountdown';
import * as sfx from '../lib/sfx';

// VOTING: only players who got the answer WRONG land here. Correct players
// already know the truth, so they sit this out and watch (see Wait.jsx) —
// that's what stops double-dipping.
//
// The payload never marks which entry is real. Entries this player wrote are
// tagged via snap.myBallotLetters and greyed out.
export default function Vote({ snap }) {
  const myVote = snap.myVote;
  const ballot = snap.ballot || [];
  const mine = snap.myBallotLetters || [];
  const seconds = useCountdown(snap.phaseEndsAt);

  const prevRef = useRef(myVote);
  useEffect(() => {
    if (!prevRef.current && myVote) sfx.voteLockedDing();
    prevRef.current = myVote;
  }, [myVote]);

  function pick(letter) {
    if (myVote || mine.includes(letter)) return;
    sendAction('vote', { letter });
  }

  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">Which one is true?</div>
        <div className="word-help">
          {myVote
            ? 'Vote locked in. Find out if you got played.'
            : 'One of these is the real answer. The rest are lies — including yours.'}
        </div>
        {seconds != null && (
          <div className={'timer ' + (seconds < 8 ? 'urgent' : '')}>
            {seconds}<span className="timer-suffix">s</span>
          </div>
        )}
      </div>

      {snap.question && <div className="phone-question">{snap.question.question}</div>}

      <div className="phone-stack">
        {ballot.map((b) => {
          const own = mine.includes(b.letter);
          const voted = myVote === b.letter;
          return (
            <button
              key={b.letter}
              className={'vote-choice' + (own ? ' is-own' : '') + (voted ? ' is-voted' : '')}
              disabled={own || !!myVote}
              onClick={() => pick(b.letter)}
              title={own ? "That's yours — can't vote for it." : ''}
            >
              <span className="letter">{b.letter}</span>
              <span className="text">{b.text}</span>
              {own && <span className="vote-choice-own-tag">Yours</span>}
              {voted && <span className="vote-choice-voted-tag">Your vote</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
