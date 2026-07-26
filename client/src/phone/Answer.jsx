import React, { useState } from 'react';
import { sendAction } from '../lib/socket';
import { useCountdown } from '../lib/useCountdown';
import * as sfx from '../lib/sfx';

// ANSWERING: type what you actually think the answer is. No choices — this is
// a sincere attempt, and the server judges it the moment it lands.
//
// The verdict comes back on the ack, so the player learns immediately whether
// they nailed it (and get sent to write a lie) or missed (and their honest
// guess quietly becomes their ballot entry). We deliberately do NOT tell a
// wrong player that they were wrong yet — that would spoil the reveal and let
// them read the ballot differently from everyone else.
export default function Answer({ snap }) {
  const [text, setText] = useState(snap.myAnswer || '');
  const [submitted, setSubmitted] = useState(!!snap.myAnswer);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rescueBusy, setRescueBusy] = useState(false);
  const seconds = useCountdown(snap.phaseEndsAt);
  const q = snap.question;
  const rescuesLeft = typeof snap.rescuesLeft === 'number' ? snap.rescuesLeft : 0;

  // "Give me one" — a believable WRONG answer for a blank, twice a game. It only
  // fills the box; locking it in is still on the player, and they can edit it
  // first. The use is spent server-side the moment one is generated, so tapping
  // again costs a second one rather than rerolling the first.
  function rescue() {
    if (rescueBusy || busy || submitted) return;
    setRescueBusy(true);
    setError('');
    sendAction('rescueAnswer').then((r) => {
      setRescueBusy(false);
      if (!r || !r.ok || !r.text) { setError((r && r.error) || 'Could not think of one.'); return; }
      setText(r.text);
    });
  }

  function submit(e) {
    if (e) e.preventDefault();
    if (busy || submitted) return;
    const clean = text.trim();
    if (!clean) { setError('Take a guess — a wrong answer still gets you votes.'); return; }
    setError('');
    setBusy(true);
    sendAction('submitAnswer', { text: clean }).then((r) => {
      setBusy(false);
      if (!r || !r.ok) { setError((r && r.error) || 'Could not submit.'); return; }
      setSubmitted(true);
      sfx.voteLockedDing();
    });
  }

  if (!q) return null;

  return (
    <div className="phone-shell">
      <div className="phone-header">
        <div className="eyebrow">{q.category}</div>
        <div className="word-help">
          {submitted
            ? 'Locked in. Sit tight…'
            : 'Type the real answer. Not sure? Guess anyway — a wrong guess joins the ballot and can still fool people.'}
        </div>
        {seconds != null && (
          <div className={'timer ' + (seconds < 8 ? 'urgent' : '')}>
            {seconds}<span className="timer-suffix">s</span>
          </div>
        )}
      </div>

      <div className="phone-question">{q.question}</div>

      {submitted ? (
        <div className="cutscene-page-stage">
          <div className="cutscene-page-headline">
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
            <span>Answer in</span>
            <span className="cutscene-page-ornament" aria-hidden="true">✦</span>
          </div>
          <div className="phone-answer-echo">{text}</div>
          <div className="cutscene-page-sub">Waiting for the rest of the room…</div>
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
            {busy ? 'Checking…' : 'Lock it in'}
          </button>
          {rescuesLeft > 0 && (
            <button
              className="lp-btn lp-btn--ghost"
              type="button"
              style={{ width: '100%' }}
              onClick={rescue}
              disabled={rescueBusy || busy}
            >
              {rescueBusy ? 'Thinking…' : 'Give me one'}
              <span className="rescue-count">{rescuesLeft} left</span>
            </button>
          )}
        </form>
      )}
    </div>
  );
}
