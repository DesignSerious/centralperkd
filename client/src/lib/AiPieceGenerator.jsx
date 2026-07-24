import React, { useState, useEffect } from 'react';
import { getSocket } from './socket';

// gpt-image-1 can take 20–40s. Rotate playful status lines so a long wait
// reads as "still working" rather than "stuck", and fall back to an
// explicit reassurance once it runs slow.
const AI_LOADING_MSGS = [
  'Dreaming up your piece…',
  'Sketching the outline…',
  'Mixing the colors…',
  'Adding character…',
  'Setting it on the base…',
  'Dusting on a little sparkle…',
];

function AiLoading() {
  const [i, setI] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const cycle = setInterval(
      () => setI((n) => (n + 1) % AI_LOADING_MSGS.length),
      3200
    );
    const slowT = setTimeout(() => setSlow(true), 28000);
    return () => { clearInterval(cycle); clearTimeout(slowT); };
  }, []);
  return (
    <div className="ai-piece-loading" role="status" aria-live="polite">
      <div className="ai-piece-orb"><span className="ai-piece-spark" /></div>
      <div className="ai-piece-loading-msg" key={i}>{AI_LOADING_MSGS[i]}</div>
      <div className="ai-piece-loading-bar" />
      <div className="ai-piece-loading-sub">
        {slow
          ? 'Still working — good pieces take a moment…'
          : 'This usually takes 20–40 seconds.'}
      </div>
    </div>
  );
}

// Modal that takes a short description from the player and asks the server
// to generate a piece via OpenAI gpt-image-1, then lets them preview /
// regenerate / accept the result. Mirrors the PhotoCapture flow:
//   - onCancel(): bail without picking a piece
//   - onConfirm(url): caller treats the returned URL as the piece value
//
// The server caps generations per socket (configurable, default 2). When
// the cap is hit the response carries `remaining: 0` and we surface the
// limit in the UI so the player knows to commit to what they have.
export default function AiPieceGenerator({ onCancel, onConfirm }) {
  const [subject, setSubject] = useState('');
  // 'character' = chibi figure with head/arms; 'object' = the thing itself,
  // no face/limbs. Sent to the server so the prompt is built accordingly.
  const [mode, setMode] = useState('character');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [error, setError] = useState('');

  function generate() {
    setError('');
    const s = subject.trim();
    if (s.length < 2) { setError('Describe the piece in a few words.'); return; }
    setLoading(true);
    setPreview(null);
    const socketId = getSocket().id || '';
    fetch('/api/generate-piece', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socketId, subject: s, mode })
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, body: j })))
      .then((out) => {
        setLoading(false);
        if (!out.ok || !out.body || !out.body.ok) {
          const msg = (out.body && out.body.error) || 'Generation failed. Try again.';
          setError(msg);
          if (out.body && typeof out.body.remaining === 'number') setRemaining(out.body.remaining);
          return;
        }
        setPreview(out.body.url);
        if (typeof out.body.remaining === 'number') setRemaining(out.body.remaining);
      })
      .catch((e) => {
        setLoading(false);
        setError('Network error: ' + e.message);
      });
  }

  function accept() {
    if (preview) onConfirm(preview);
  }

  const outOfAttempts = remaining === 0 && !preview;

  return (
    <div className="lp-modal-backdrop" onClick={onCancel}>
      <div className="lp-modal ai-piece-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="lp-modal-title">Generate a piece with AI</div>
        <div className="lp-modal-body">
          {loading
            ? 'Hang tight — your piece is being conjured.'
            : preview
              ? "Like it? Keep it or generate another."
              : mode === 'object'
                ? "An object — rendered as the real thing on the base, no face or limbs (e.g. 'a dodge charger car', 'a steaming bowl of ramen', 'a vintage typewriter')."
                : "A character — a chibi figure with head and arms (e.g. 'a wizard with a long beard', 'my dog as a knight', 'a rockstar with pink hair'). The style and base are added automatically."}
        </div>

        {loading ? (
          <AiLoading />
        ) : preview ? (
          <div className="ai-piece-preview">
            <img src={preview} alt="Generated piece" />
          </div>
        ) : (
          <>
            <div className="ai-piece-mode" role="group" aria-label="Piece type">
              <button
                type="button"
                className={'ai-piece-mode-btn' + (mode === 'character' ? ' is-on' : '')}
                aria-pressed={mode === 'character'}
                onClick={() => setMode('character')}
              >
                Character
              </button>
              <button
                type="button"
                className={'ai-piece-mode-btn' + (mode === 'object' ? ' is-on' : '')}
                aria-pressed={mode === 'object'}
                onClick={() => setMode('object')}
              >
                Object
              </button>
            </div>
            <input
              className="lp-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={mode === 'object' ? 'Describe the object' : 'Describe your character'}
              maxLength={200}
              autoFocus
            />
          </>
        )}

        {!loading && remaining != null && (
          <div className="ai-piece-remaining">
            {remaining > 0
              ? remaining + ' AI generation' + (remaining === 1 ? '' : 's') + ' left this game'
              : 'No AI generations left. Pick this one or choose another piece.'}
          </div>
        )}

        {!loading && error && <div className="error">{error}</div>}

        <div className="lp-modal-actions ai-piece-actions">
          <button type="button" className="lp-btn lp-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          {preview ? (
            <>
              <button type="button" className="lp-btn lp-btn--ghost" onClick={() => { setPreview(null); }} disabled={outOfAttempts}>
                Regenerate
              </button>
              <button type="button" className="lp-btn" onClick={accept}>
                Use this piece
              </button>
            </>
          ) : (
            <button type="button" className="lp-btn" onClick={generate} disabled={loading || outOfAttempts}>
              {loading ? 'Generating…' : 'Generate'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
