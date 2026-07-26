import React from 'react';

// "How to play" overlay, opened from the phone lobby and the TV's ? button.
// Reads the live settings off the snapshot so the rules always describe the
// room's actual configuration rather than hard-coded defaults.
export default function RulesOverlay({ snap, onClose }) {
  const s = (snap && snap.settings) || {};
  const boardSpaces = s.boardSpaces || 32;
  const answerSeconds = s.answerSeconds || 25;
  const bluffSeconds = s.bluffSeconds || 20;
  const voteSeconds = s.voteSeconds || 25;
  const finalQuestion = !!s.finalRoundToClinch;
  const ptsAnswer = s.pointsCorrectAnswer == null ? 3 : s.pointsCorrectAnswer;
  const ptsVote = s.pointsPerVote == null ? 2 : s.pointsPerVote;
  const ptsTruth = s.pointsFoundTruth == null ? 1 : s.pointsFoundTruth;

  return (
    <div className="lp-modal-backdrop" onClick={onClose}>
      <div className="rules-overlay" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button type="button" className="rules-close" onClick={onClose} aria-label="Close rules">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6 L18 18" />
            <path d="M18 6 L6 18" />
          </svg>
        </button>

        <div className="rules-title">How to Play</div>
        <p className="rules-tagline">Friends trivia, played as a race. Know it, or fake it.</p>

        <div className="rules-section">
          <div className="rules-h">Each Round</div>
          <ol className="rules-list">
            <li>A question goes up on the TV. No options — <strong>type</strong> what
              you think the answer is. You get <strong>{answerSeconds} seconds</strong>.</li>
            <li>Everyone who got it right now writes a <strong>convincing lie</strong>
              {' '}({bluffSeconds}s). Everyone who got it wrong sits this bit out.</li>
            <li>The real answer and all the lies go up together, shuffled. Anyone who
              got it wrong has {voteSeconds} seconds to pick the one they think is
              true.</li>
            <li>The truth is revealed, then every piece moves up the board.</li>
          </ol>
        </div>

        <div className="rules-section">
          <div className="rules-h">Moving</div>
          <ul className="rules-points">
            <li><span className="pts">+{ptsAnswer}</span><span>you <strong>knew</strong> the answer</span></li>
            <li><span className="pts">+{ptsVote}</span><span>each vote your <strong>lie</strong> pulled in</span></li>
            <li><span className="pts">+{ptsTruth}</span><span>you <strong>found</strong> the truth in the list</span></li>
            <li><span className="pts">0</span><span>wrong, and fooled by someone else</span></li>
          </ul>
        </div>

        <div className="rules-section">
          <div className="rules-h">The Board</div>
          <p className="rules-body">
            {boardSpaces} moves from the doormat to the couch, and where you land matters:
          </p>
          <ul className="rules-body-list">
            <li><strong>→ Arrow</strong> — nudges you further along the path: the blue
              arrow 1 space, the purple ones 2.</li>
            <li><strong>☕ Coffee cup</strong> — your next scoring move is worth double.
              All of it: knowing the answer, votes your entry pulls, spotting the truth.
              Score nothing and you keep it for next round.</li>
          </ul>
          <p className="rules-body">
            Nothing on this board sends you backwards — a round either moves you
            forward or leaves you where you are.
          </p>
        </div>

        <div className="rules-section">
          <div className="rules-h">Give me one</div>
          <p className="rules-body">
            Drawn a total blank? The answer screen has a <strong>Give me one</strong> button
            that writes a believable wrong answer for you. It won't score you the
            points for knowing it — but it puts something on the ballot, and people
            do vote for it. Two per player, per game, and nobody is told you used one.
          </p>
        </div>

        <div className="rules-section">
          <div className="rules-h">Winning</div>
          <p className="rules-body">
            {finalQuestion
              ? 'Reaching the couch arms the clincher: you take the game the next round you score. Miss out and you simply wait on the line and try again.'
              : 'First piece to reach the couch wins outright.'}
          </p>
          <p className="rules-body">
            <strong>☕ Face-off</strong> — if two or more of you reach the couch in
            the same round, nobody is handed the win. It's sudden death between
            you: one question, no bluffing, no voting. The fastest correct answer
            takes the game. Nobody gets it, you go again on a new question.
          </p>
        </div>

        <div className="rules-section">
          <div className="rules-h">Tips</div>
          <ul className="rules-body-list">
            <li>Spelling and phrasing are forgiven — "chan bing" counts. Write what you mean.</li>
            <li>Guessing beats not answering: a wrong answer costs the same as no answer.</li>
            <li>The best lie is a real Friends detail that just isn't the answer.</li>
            <li>Watch the board, not just the score. An arrow can flip the whole race.</li>
          </ul>
        </div>

        <button type="button" className="lp-btn" style={{ width: '100%', marginTop: 18 }} onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
