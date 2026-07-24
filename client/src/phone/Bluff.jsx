import React, { useEffect, useState } from 'react';
import { sendAction } from '../lib/socket';
import { useCountdown } from '../lib/useCountdown';
import * as sfx from '../lib/sfx';

// BLUFFING: only players who got the answer RIGHT land here. They already
// banked their answer points — now they write a lie to farm votes off everyone
// who missed it.
//
// The server re-runs the judging funnel on the lie and rejects anything that
// is really the truth in disguise, so the ballot can never hold two true
// answers. That rejection arrives as a normal error on the ack.
export default function Bluff({ snap }) {
  const [text, setText] = useState(snap.myBluff || '');
  const [submitted, setSubmitted] = useState(!!snap.myBluff);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const seconds = useCountdown(snap.phaseEndsAt);
  const q = snap.question;

  // The "you nailed it" moment lands here, once.
  useEffect(() => { sfx.reveal(true, true); }, []);

  function submit(e) {
    if (e) e.preventDefault();
    if (busy || submitted) return;
    const clean = text.trim();
    if (!clean) { setError('Write something believable.'); return; }
    setError('');
    setBusy(true);
    sendAction('submitBluff', { text: clean }).then((r) => {
      setBusy(false);
      if (!r || !r.ok) { setError((r && r.error) || 'Could not submit.'); return; }
      setSubmitted(true);
      sfx.voteLockedDing();
    });
  }

  function autoBluff() {
    if (autoBusy) return;
    setAutoBusy(true);
    setError('');
    sendAction('randomBluff').then((r) => {
      setAutoBusy(false);
      if (!r || !r.ok || !r.text) { setError((r && r.error) || 'Write your own.'); return; }
      setText(r.text);
    });
  }

  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">You nailed it! 🎉</div>
        <div className="word-help">
          {submitted
            ? 'Lie submitted. Now watch who bites.'
            : 'Points banked. Now write a LIE — every player who votes for it moves you further.'}
        </div>
        {seconds != null && (
          <div className={'timer ' + (seconds < 8 ? 'urgent' : '')}>
            {seconds}<span className="timer-suffix">s</span>
          </div>
        )}
      </div>

      {q && <div className="phone-question">{q.question}</div>}

      {submitted ? (
        <div className="cutscene-page-stage">
          <div className="cutscene-page-headline">
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
            <span>Lie planted</span>
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          </div>
          <div className="phone-answer-echo">{text}</div>
        </div>
      ) : (
        <form onSubmit={submit} className="phone-stack">
          <input
            className="lp-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Something believable but false"
            maxLength={120}
            autoFocus
            autoCapitalize="sentences"
          />
          {error && <div className="error">{error}</div>}
          <button className="lp-btn" type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Checking…' : 'Plant the lie'}
          </button>
          <button
            className="lp-btn lp-btn--ghost"
            type="button"
            style={{ width: '100%' }}
            onClick={autoBluff}
            disabled={autoBusy}
          >
            {autoBusy ? 'Thinking…' : 'Give me one'}
          </button>
        </form>
      )}
    </div>
  );
}
