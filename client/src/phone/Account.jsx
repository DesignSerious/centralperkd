import React, { useState, useEffect } from 'react';
import { getAuth, signup, login, signOut, saveAvatar, loginWithTwen } from '../lib/auth';
import { ready as twenReady, twenSignIn, twenAccessToken, twenUser } from '../lib/twen';
import { PIECES, pieceById, isPhotoPiece, isAiPiece } from '../lib/pieces';
import PieceVisual from '../lib/PieceVisual';
import PhotoCapture from '../lib/PhotoCapture';
import AiPieceGenerator from '../lib/AiPieceGenerator';

// Account overlay: sign in / create account, or — when already signed in —
// the profile card with cross-game stats. Always reachable from the join
// screen; "Continue as guest" just closes it and the normal guest flow runs.
export default function Account({ onClose }) {
  const auth = getAuth();
  if (auth && auth.user) {
    return <Profile user={auth.user} onClose={onClose} />;
  }
  return <AuthForms onClose={onClose} />;
}

function AvatarBubble({ avatar, size = 84 }) {
  if (!avatar) {
    return <div className="acct-avatar acct-avatar--empty" aria-hidden="true">✦</div>;
  }
  if (isPhotoPiece(avatar)) {
    return <img className="acct-avatar acct-avatar--photo" src={avatar} alt="Your avatar" />;
  }
  if (isAiPiece(avatar)) {
    return <div className="acct-avatar"><PieceVisual id={avatar} size={size} glow /></div>;
  }
  const p = pieceById(avatar);
  return (
    <div className="acct-avatar">
      {p && p.image
        ? <img src={p.image} alt={p.label} style={{ width: size, height: size }} />
        : <PieceVisual id={avatar} size={size} glow />}
    </div>
  );
}

function Profile({ user, onClose }) {
  // Local mirror so the new piece shows instantly; saveAvatar() persists it
  // to the account and updates the shared auth cache, so it then prefills
  // the join screen and shows everywhere until changed again.
  const [avatar, setAvatarState] = useState(user.avatar || null);
  const [picking, setPicking] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAi, setShowAi] = useState(false);

  function choose(piece) {
    if (!piece) return;
    setAvatarState(piece);
    saveAvatar(piece);
    setPicking(false);
  }

  const stats = [
    { label: 'Games', value: user.gamesPlayed },
    { label: 'Wins', value: user.gamesWon },
    { label: 'Win rate', value: user.winRate + '%' },
    { label: 'Correct', value: user.correctAnswers },
    { label: 'Best streak', value: user.bestStreak },
    { label: 'Avg / game', value: user.avgCorrect + ' right' }
  ];

  return (
    <div className="lp-modal-backdrop" onClick={onClose}>
      <div className="lp-modal acct-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {picking ? (
          <>
            <div className="lp-modal-title">Your piece</div>
            <div className="lp-modal-body">Pick your default — it shows everywhere until you change it.</div>
            <div className="piece-grid acct-piece-grid">
              <button
                type="button"
                className={'piece-tile piece-tile--camera ' + (isPhotoPiece(avatar) ? 'selected' : '')}
                onClick={() => setShowCamera(true)}
                aria-label="Take a photo to use as your piece"
              >
                <div className="piece-tile-art">
                  {isPhotoPiece(avatar)
                    ? <img className="piece-tile-photo" src={avatar} alt="Your photo" />
                    : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 8 h3 l2 -2 h6 l2 2 h3 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 V10 a2 2 0 0 1 2 -2 Z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                    )}
                </div>
                <div className="label">{isPhotoPiece(avatar) ? 'Retake' : 'Take a Photo'}</div>
              </button>
              <button
                type="button"
                className={'piece-tile piece-tile--ai ' + (isAiPiece(avatar) ? 'selected' : '')}
                onClick={() => setShowAi(true)}
                aria-label="Generate a piece with AI"
              >
                <div className="piece-tile-art">
                  {isAiPiece(avatar)
                    ? <PieceVisual id={avatar} size={92} glow />
                    : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3 l1.6 4.4 L18 9 l-4.4 1.6 L12 15 l-1.6 -4.4 L6 9 l4.4 -1.6 Z" />
                      </svg>
                    )}
                </div>
                <div className="label">{isAiPiece(avatar) ? 'Regenerate' : 'Generate with AI'}</div>
              </button>
              {PIECES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={'piece-tile ' + (avatar === p.id ? 'selected ' : '')}
                  onClick={() => choose(p.id)}
                  aria-label={p.label}
                >
                  <div className="piece-tile-art">
                    <PieceVisual id={p.id} size={92} glow={avatar === p.id} />
                  </div>
                  <div className="label">{p.label}</div>
                </button>
              ))}
            </div>
            <div className="lp-modal-actions">
              <button type="button" className="lp-btn lp-btn--ghost" onClick={() => setPicking(false)}>Back</button>
            </div>
          </>
        ) : (
          <>
            <div className="acct-head">
              <AvatarBubble avatar={avatar} />
              <div className="acct-name">{user.username}</div>
              <div className="acct-sub">Your stats carry across every game.</div>
              <button type="button" className="acct-change-piece" onClick={() => setPicking(true)}>
                Change piece
              </button>
            </div>
            <div className="acct-stats">
              {stats.map((s) => (
                <div className="acct-stat" key={s.label}>
                  <div className="acct-stat-value">{s.value}</div>
                  <div className="acct-stat-label">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="lp-modal-actions">
              <button type="button" className="lp-btn lp-btn--ghost" onClick={() => { signOut(); onClose(); }}>
                Sign out
              </button>
              <button type="button" className="lp-btn" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
      {showCamera && (
        <PhotoCapture
          onCancel={() => setShowCamera(false)}
          onConfirm={(dataUrl) => { setShowCamera(false); choose(dataUrl); }}
        />
      )}
      {showAi && (
        <AiPieceGenerator
          onCancel={() => setShowAi(false)}
          onConfirm={(url) => { setShowAi(false); choose(url); }}
        />
      )}
    </div>
  );
}

function AuthForms({ onClose }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'create'
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // TWEN is offered only once its script has actually loaded — a button that
  // cannot work is worse than no button, especially mid-round on a phone.
  const [twenOk, setTwenOk] = useState(false);

  useEffect(() => {
    let alive = true;
    twenReady().then((ok) => { if (alive) setTwenOk(ok); });
    return () => { alive = false; };
  }, []);

  function twen() {
    setError('');
    setBusy(true);
    const first = twenUser() ? Promise.resolve(twenUser()) : twenSignIn();
    first
      .then(() => twenAccessToken())
      .then((tok) => {
        if (!tok) throw new Error('No TWEN session to use.');
        return loginWithTwen(tok);
      })
      .then(() => { setBusy(false); onClose(); })
      .catch((err) => { setBusy(false); setError(err.message || 'Could not sign in with TWEN.'); });
  }

  function submit(e) {
    e.preventDefault();
    setError('');
    const u = username.trim();
    if (u.length < 3) { setError('Username must be at least 3 characters.'); return; }
    if (!/^[0-9]{4,6}$/.test(pin)) { setError('PIN must be 4 to 6 digits.'); return; }
    setBusy(true);
    const run = mode === 'create' ? signup(u, pin) : login(u, pin);
    run.then(() => { setBusy(false); onClose(); })
      .catch((err) => { setBusy(false); setError(err.message || 'Could not sign in.'); });
  }

  return (
    <div className="lp-modal-backdrop" onClick={onClose}>
      <div className="lp-modal acct-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="lp-modal-title">{mode === 'create' ? 'Create account' : 'Sign in'}</div>
        <div className="acct-tabs">
          <button
            type="button"
            className={'acct-tab' + (mode === 'signin' ? ' acct-tab--on' : '')}
            onClick={() => { setMode('signin'); setError(''); }}
          >Sign in</button>
          <button
            type="button"
            className={'acct-tab' + (mode === 'create' ? ' acct-tab--on' : '')}
            onClick={() => { setMode('create'); setError(''); }}
          >Create account</button>
        </div>
        <form onSubmit={submit} className="phone-stack">
          <div>
            <label className="lp-label">Username</label>
            <input
              className="lp-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. WordWizard"
              maxLength={20}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="lp-label">PIN (4–6 digits)</label>
            <input
              className="lp-input"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••"
              inputMode="numeric"
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              type="password"
            />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="lp-btn" type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Please wait…' : (mode === 'create' ? 'Create account' : 'Sign in')}
          </button>
        </form>
        {twenOk && (
          <>
            <div className="acct-or">or</div>
            <button
              type="button"
              className="lp-btn lp-btn--twen"
              style={{ width: '100%' }}
              onClick={twen}
              disabled={busy}
            >
              {twenUser() ? 'Continue as ' + twenUser().name : 'Sign in with TWEN'}
            </button>
            <div className="acct-note">
              One account across Central Perk'd, Wilderdash, Kroaky and the rest — no PIN to forget.
            </div>
          </>
        )}
        <button type="button" className="lp-btn lp-btn--ghost" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>
          Continue as guest
        </button>
      </div>
    </div>
  );
}
