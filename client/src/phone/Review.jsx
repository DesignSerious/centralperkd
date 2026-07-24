import React, { useEffect, useRef } from 'react';
import { sendAction } from '../lib/socket';
import PieceVisual from '../lib/PieceVisual';
import * as sfx from '../lib/sfx';

// REVIEW phase on the phone. A wrongly-judged player disputed their answer; the
// OTHER players now vote yes/no to overturn it. This one screen covers every
// role: the disputer waits, eligible players get Yes/No, everyone else watches,
// and all of them see the verdict when it lands.
export default function Review({ snap }) {
  const rv = snap.review;
  const cue = useRef(false);
  useEffect(() => { if (!cue.current) { cue.current = true; sfx.wordReveal(); } }, []);

  if (!rv) {
    return <div className="phone-shell"><div className="phone-status">Loading…</div></div>;
  }

  const resolved = rv.resolved;
  const disputer = snap.isDisputer;
  const tally = <div className="phone-review-tally">Yes {rv.yes} · No {rv.no} of {rv.voterCount}</div>;

  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">Answer review</div>
      </div>

      {/* The disputed answer vs. the real answer — the whole basis for the vote. */}
      <div className="phone-review-card">
        <div className="phone-review-who">
          <PieceVisual id={rv.piece} size={44} />
          <span>{disputer ? 'Your answer' : rv.name + '’s answer'}</span>
        </div>
        <div className="phone-review-answer">&ldquo;{rv.answerText}&rdquo;</div>
        <div className="phone-review-vs">the real answer was</div>
        <div className="phone-review-truth">&ldquo;{rv.truth}&rdquo;</div>
      </div>

      {resolved ? (
        <div className={'phone-review-verdict ' + (rv.passed ? 'is-pass' : 'is-deny')}>
          <div className="phone-review-verdict-head">
            {rv.passed ? 'Overturned — it counts! ✓' : 'Denied — the ruling stands.'}
          </div>
          {tally}
        </div>
      ) : disputer ? (
        <div className="phone-review-wait">
          <div className="lp-spinner spinner" />
          <div>The table is deciding whether your answer counts…</div>
          {tally}
        </div>
      ) : snap.canReviewVote ? (
        <div className="phone-review-vote">
          <div className="phone-review-q">Should {rv.name}&rsquo;s answer count as correct?</div>
          <div className="phone-review-btns">
            <button
              type="button"
              className={'lp-btn phone-review-yes' + (snap.myReviewVote === 'yes' ? ' is-selected' : '')}
              onClick={() => sendAction('castReviewVote', { vote: 'yes' })}
            >
              Yes, it counts
            </button>
            <button
              type="button"
              className={'lp-btn lp-btn--ghost phone-review-no' + (snap.myReviewVote === 'no' ? ' is-selected' : '')}
              onClick={() => sendAction('castReviewVote', { vote: 'no' })}
            >
              No
            </button>
          </div>
          {snap.myReviewVote
            ? <div className="phone-review-hint">You voted {snap.myReviewVote === 'yes' ? 'Yes' : 'No'} — tap to change. Yes {rv.yes} · No {rv.no}</div>
            : <div className="phone-review-hint">Majority decides.</div>}
        </div>
      ) : (
        <div className="phone-review-wait">
          <div className="lp-spinner spinner" />
          <div>The table is reviewing {rv.name}&rsquo;s answer…</div>
          {tally}
        </div>
      )}

      {rv.remaining > 0 && (
        <div className="phone-review-hint">
          {rv.remaining} more {rv.remaining === 1 ? 'dispute' : 'disputes'} after this.
        </div>
      )}
    </div>
  );
}
