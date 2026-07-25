import React, { useState, useEffect } from 'react';
import { getSocket } from '../lib/socket';
import { PIECES, isPhotoPiece, isAiPiece } from '../lib/pieces';
import PieceVisual from '../lib/PieceVisual';
import PhotoCapture from '../lib/PhotoCapture';
import AiPieceGenerator from '../lib/AiPieceGenerator';
import Account from './Account';
import { getAuth, subscribeAuth, getToken } from '../lib/auth';

// Three-step join: code -> name + piece -> in.
// Pieces taken by other players are disabled.
export default function Join({ onJoined }) {
  const [step, setStep] = useState('code');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [piece, setPiece] = useState(null);
  const [error, setError] = useState('');
  const [takenPieces, setTakenPieces] = useState([]);
  const [showCamera, setShowCamera] = useState(false);
  const [showAiGen, setShowAiGen] = useState(false);
  const [auth, setAuthState] = useState(getAuth());
  const [showAccount, setShowAccount] = useState(false);

  // Track sign-in changes (sign in/out from the Account modal).
  useEffect(() => subscribeAuth(setAuthState), []);

  // Deep-link from the TV's QR code: /join?code=XXXX pre-fills the room code and
  // jumps straight to the name step, so scanning skips manual code entry.
  useEffect(() => {
    let param = '';
    try { param = new URLSearchParams(window.location.search).get('code') || ''; } catch (e) {}
    const clean = param.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length !== 4) return;
    setCode(clean);
    getSocket().emit('room:peek', { code: clean }, (res) => {
      if (res && res.ok) {
        setTakenPieces(res.takenPieces || []);
        setStep('details');
      }
      // Invalid/closed room → stay on the code step with it pre-filled.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When signed in, prefill name + avatar — but only fields the player
  // hasn't touched yet, so guests and manual edits are never overridden.
  useEffect(() => {
    if (!auth || !auth.user) return;
    setName((n) => (n ? n : auth.user.username || ''));
    setPiece((p) => (p ? p : (auth.user.avatar || null)));
  }, [auth]);

  function submitCode(e) {
    e.preventDefault();
    setError('');
    const clean = code.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length !== 4) { setError('Room codes are 4 letters.'); return; }
    setCode(clean);
    // Peek the room so the picker can gray out pieces already in use, and
    // catch invalid codes before the user fills out a name.
    getSocket().emit('room:peek', { code: clean }, (res) => {
      if (!res || !res.ok) {
        setError(res && res.error ? res.error : 'Could not find that room.');
        return;
      }
      setTakenPieces(res.takenPieces || []);
      setStep('details');
    });
  }

  function submitDetails(e) {
    e.preventDefault();
    setError('');
    // Capitalize the first letter so "michael" displays as "Michael" on the
    // badge, lobby list, and ballot — matches what the server stores too.
    const trimmed = name.trim();
    const cleanName = (trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : '').slice(0, 20);
    if (cleanName.length < 1) { setError('Pick a name.'); return; }
    if (!piece) { setError('Choose a piece.'); return; }
    getSocket().emit('player:join', { code, name: cleanName, piece, authToken: getToken() }, (res) => {
      if (!res || !res.ok) {
        setError(res && res.error ? res.error : 'Could not join.');
        // If a piece is taken, refresh disabled list
        if (res && /piece/i.test(res.error || '') && !isPhotoPiece(piece)) setTakenPieces((t) => t.concat(piece));
        return;
      }
      const stored = { code: res.code, playerId: res.playerId, name: cleanName, piece };
      try { localStorage.setItem('cperkd_player', JSON.stringify(stored)); } catch (e) {}
      onJoined(stored);
    });
  }

  return (
    <div className="phone-shell phone-shell--splash">
      <img className="phone-logo" src="/central-perkd-logo.png" alt="Central Perk'd" />
      <div className="acct-bar">
        {auth && auth.user ? (
          <button type="button" className="acct-chip" onClick={() => setShowAccount(true)}>
            <span className="acct-chip-dot" aria-hidden="true" />
            {auth.user.username} · Profile
          </button>
        ) : (
          <button type="button" className="acct-link" onClick={() => setShowAccount(true)}>
            Sign in / Create account
          </button>
        )}
      </div>
      {step === 'code' && (
        <form onSubmit={submitCode}>
          <h1 className="phone-h1">Enter Room Code</h1>
          <p className="phone-sub">Look at the TV screen for the 4-letter code.</p>
          <input
            className="lp-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Type code here"
            maxLength={4}
            autoFocus
            autoCapitalize="characters"
            spellCheck={false}
            style={{ textAlign: 'center', fontFamily: 'var(--serif)', fontSize: code ? '2.2rem' : '1.1rem', letterSpacing: code ? '0.3em' : '0.08em' }}
          />
          <div className="error">{error}</div>
          <div style={{ marginTop: 18 }}>
            <button className="lp-btn" type="submit" style={{ width: '100%' }}>Continue</button>
          </div>
        </form>
      )}

      {step === 'details' && (
        <form onSubmit={submitDetails} className="phone-stack-lg">
          <h1 className="phone-h1">Who are you?</h1>
          <div>
            <label className="lp-label">Your Name</label>
            <div className="name-join-row">
              <input
                className="lp-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane"
                maxLength={20}
                autoFocus
              />
              <button className="lp-btn name-join-btn" type="submit">Join</button>
            </div>
            {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
          </div>
          <div>
            <label className="lp-label">Pick your piece</label>
            <div className="piece-grid">
              <button
                key="__photo__"
                type="button"
                className={'piece-tile piece-tile--camera ' + (isPhotoPiece(piece) ? 'selected' : '')}
                onClick={() => setShowCamera(true)}
                aria-label="Take a photo to use as your piece"
              >
                <div className="piece-tile-art">
                  {isPhotoPiece(piece)
                    ? <img className="piece-tile-photo" src={piece} alt="Your photo" />
                    : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 8 h3 l2 -2 h6 l2 2 h3 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 V10 a2 2 0 0 1 2 -2 Z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                    )}
                </div>
                <div className="label">
                  {isPhotoPiece(piece) ? 'Retake' : 'Take a Photo'}
                </div>
              </button>
              <button
                key="__ai__"
                type="button"
                className={'piece-tile piece-tile--ai ' + (isAiPiece(piece) ? 'selected' : '')}
                onClick={() => setShowAiGen(true)}
                aria-label="Generate a piece with AI"
              >
                <div className="piece-tile-art">
                  {isAiPiece(piece)
                    ? <PieceVisual id={piece} size={92} glow />
                    : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3 l1.6 4.4 L18 9 l-4.4 1.6 L12 15 l-1.6 -4.4 L6 9 l4.4 -1.6 Z" />
                        <path d="M19 14 l0.6 1.6 L21 16 l-1.4 0.4 L19 18 l-0.6 -1.6 L17 16 l1.4 -0.4 Z" />
                        <path d="M5 16 l0.6 1.6 L7 18 l-1.4 0.4 L5 20 l-0.6 -1.6 L3 18 l1.4 -0.4 Z" />
                      </svg>
                    )}
                </div>
                <div className="label">
                  {isAiPiece(piece) ? 'Regenerate' : 'Generate with AI'}
                </div>
              </button>
              {PIECES.map((p) => {
                const disabled = takenPieces.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={'piece-tile ' + (piece === p.id ? 'selected ' : '') + (disabled ? 'disabled' : '')}
                    onClick={() => !disabled && setPiece(p.id)}
                    disabled={disabled}
                    aria-label={p.label}
                  >
                    <div className="piece-tile-art">
                      <PieceVisual id={p.id} size={92} glow={piece === p.id} />
                    </div>
                    <div className="label">{p.label}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <button className="lp-btn lp-btn--ghost" type="button" style={{ width: '100%' }} onClick={() => setStep('code')}>
            Use a different code
          </button>
        </form>
      )}
      {showCamera && (
        <PhotoCapture
          onCancel={() => setShowCamera(false)}
          onConfirm={(dataUrl) => { setPiece(dataUrl); setShowCamera(false); }}
        />
      )}
      {showAiGen && (
        <AiPieceGenerator
          onCancel={() => setShowAiGen(false)}
          onConfirm={(url) => { setPiece(url); setShowAiGen(false); }}
        />
      )}
      {showAccount && <Account onClose={() => setShowAccount(false)} />}
    </div>
  );
}
