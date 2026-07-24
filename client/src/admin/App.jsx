import React, { useEffect, useState } from 'react';
import AdminNav from '../lib/AdminNav';
import { loadAdminPwd, saveAdminPwd, clearAdminPwd } from '../lib/adminAuth';

// Central Perk'd admin control panel.
//   1. Login (reuses PLAYLIST_PASSWORD via /api/playlist/login; the password is
//      shared with /sounds and /playlist, so signing in here signs you into all
//      of them).
//   2. Dashboard: quick links to the sub-admins (Sound / Music / Board path) +
//      the game's DEFAULT settings, which every new game starts from. Saving
//      writes them server-side (server/game-settings.json); the lobby can still
//      override per-game.
export default function App() {
  const [password, setPassword] = useState(() => loadAdminPwd());
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authing, setAuthing] = useState(false);

  useEffect(() => {
    if (!password) return;
    setAuthing(true);
    fetch('/api/playlist/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    }).then((r) => r.json()).then((d) => {
      if (d && d.ok) setAuthed(true);
      else { setPassword(''); clearAdminPwd(); }
    }).catch(() => {}).finally(() => setAuthing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function login(e) {
    e.preventDefault(); setAuthError(''); setAuthing(true);
    fetch('/api/playlist/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    }).then((r) => r.json()).then((d) => {
      if (d && d.ok) { saveAdminPwd(password); setAuthed(true); }
      else setAuthError((d && d.error) || 'Wrong password.');
    }).catch((e) => setAuthError(e.message)).finally(() => setAuthing(false));
  }
  function logout() { clearAdminPwd(); setPassword(''); setAuthed(false); }

  if (!authed) {
    return (
      <div className="ad-shell">
        <div className="ad-card ad-login">
          <h1 className="ad-title">Admin</h1>
          <p className="ad-sub">Enter the password to manage the game.</p>
          <form onSubmit={login}>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
              className="ad-input" placeholder="Password" />
            {authError && <div className="ad-error">{authError}</div>}
            <button type="submit" className="ad-btn" disabled={authing || !password}>
              {authing ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    );
  }
  return <Dashboard password={password} onLogout={logout} />;
}

// ── small controls ──
function Seg({ options, value, onChange }) {
  return (
    <div className="ad-seg">
      {options.map((o) => (
        <button key={String(o.v)} type="button"
          className={'ad-seg-btn' + (o.v === value ? ' is-on' : '')}
          onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}
function Stepper({ value, onChange, min = 0, max = 10 }) {
  const v = Number.isInteger(value) ? value : 0;
  return (
    <div className="ad-stepper">
      <button type="button" onClick={() => onChange(Math.max(min, v - 1))} aria-label="decrease">−</button>
      <span className="ad-stepper-val">{v}</span>
      <button type="button" onClick={() => onChange(Math.min(max, v + 1))} aria-label="increase">+</button>
    </div>
  );
}

const LINKS = [
  { href: '/sounds', icon: '🔊', title: 'Sound Board', desc: 'Upload & assign the game sound effects.' },
  { href: '/playlist', icon: '🎵', title: 'Music', desc: 'Organize the background-music playlists.' },
  { href: '/tv?adjust', icon: '🎯', title: 'Board Path', desc: 'Nudge where pieces sit on the board (?calibrate re-traces).' },
  { href: '/tv', icon: '📺', title: 'Open TV', desc: 'Launch the game board on the big screen.' },
  { href: '/join', icon: '📱', title: 'Join', desc: 'The phone join screen.' }
];

function Dashboard({ password, onLogout }) {
  const [settings, setSettings] = useState(null);
  const [meta, setMeta] = useState({ allCategories: [], choices: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const auth = { Authorization: 'Bearer ' + password };

  useEffect(() => {
    fetch('/api/game-settings', { headers: auth })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) throw new Error((d && d.error) || 'Could not load settings.');
        setSettings(d.settings);
        setMeta({ allCategories: d.allCategories || [], choices: d.choices || {} });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  function save() {
    setSaving(true); setError('');
    fetch('/api/game-settings', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) throw new Error((d && d.error) || 'Save failed.');
        setSettings(d.settings);   // reflect the server's sanitized result
        setSavedAt(new Date());
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  }

  if (loading || !settings) {
    return (
      <div className="ad-shell"><div className="ad-card">
        {error ? <div className="ad-error">Could not load: {error}</div> : <div className="ad-loading">Loading…</div>}
      </div></div>
    );
  }

  const ch = meta.choices || {};
  const boardOpts = (ch.boardSpaces || [16, 32, 48]).map((n) => ({ v: n, label: (n === 16 ? 'Short' : n === 48 ? 'Long' : 'Standard') + ' (' + n + ')' }));
  const secOpts = (arr) => (arr || []).map((n) => ({ v: n, label: n + 's' }));
  const allCats = meta.allCategories || [];
  const onCats = settings.categories && settings.categories.length ? settings.categories : allCats;
  function toggleCat(c) {
    const next = onCats.includes(c) ? onCats.filter((x) => x !== c) : onCats.concat(c);
    set('categories', next);
  }
  const onOff = [{ v: false, label: 'Off' }, { v: true, label: 'On' }];

  return (
    <>
      <AdminNav current="admin" onSignOut={onLogout} />
      <div className="ad-shell">
      <div className="ad-card ad-card--wide">
        <div className="ad-header">
          <h1 className="ad-title">Control Panel</h1>
        </div>

        {/* Quick links */}
        <div className="ad-links">
          {LINKS.map((l) => (
            <a key={l.href} className="ad-link" href={l.href}>
              <span className="ad-link-icon" aria-hidden="true">{l.icon}</span>
              <span className="ad-link-body">
                <span className="ad-link-title">{l.title}</span>
                <span className="ad-link-desc">{l.desc}</span>
              </span>
            </a>
          ))}
        </div>

        {/* Game defaults */}
        <div className="ad-settings-head">
          <h2 className="ad-h2">Game settings</h2>
          <div className="ad-settings-actions">
            {savedAt && <span className="ad-saved">Saved {savedAt.toLocaleTimeString()}</span>}
            {error && <span className="ad-error ad-error-inline">{error}</span>}
            <button className="ad-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
        <p className="ad-note">These are the defaults every new game starts from. The lobby can still change them for a single game.</p>

        <div className="ad-rows">
          <Row label="Board length">
            <Seg options={boardOpts} value={settings.boardSpaces} onChange={(v) => set('boardSpaces', v)} />
          </Row>
          <Row label="Answer time">
            <Seg options={secOpts(ch.answerSeconds)} value={settings.answerSeconds} onChange={(v) => set('answerSeconds', v)} />
          </Row>
          <Row label="Bluff time">
            <Seg options={secOpts(ch.bluffSeconds)} value={settings.bluffSeconds} onChange={(v) => set('bluffSeconds', v)} />
          </Row>
          <Row label="Vote time">
            <Seg options={secOpts(ch.voteSeconds)} value={settings.voteSeconds} onChange={(v) => set('voteSeconds', v)} />
          </Row>

          <Row label="Categories" hint="All on = every category. Turn some off to narrow the questions.">
            <div className="ad-cats">
              {allCats.map((c) => (
                <button key={c} type="button"
                  className={'ad-cat' + (onCats.includes(c) ? ' is-on' : '')}
                  onClick={() => toggleCat(c)}>{c}</button>
              ))}
            </div>
          </Row>

          <Row label="Spaces per…">
            <div className="ad-steppers">
              <StepRow label="knowing it"><Stepper value={settings.pointsCorrectAnswer} onChange={(v) => set('pointsCorrectAnswer', v)} /></StepRow>
              <StepRow label="each vote you pull"><Stepper value={settings.pointsPerVote} onChange={(v) => set('pointsPerVote', v)} /></StepRow>
              <StepRow label="finding the truth"><Stepper value={settings.pointsFoundTruth} onChange={(v) => set('pointsFoundTruth', v)} /></StepRow>
              <StepRow label="☕ tile multiplier"><Stepper value={settings.bonusTileMultiplier} onChange={(v) => set('bonusTileMultiplier', v)} min={1} /></StepRow>
            </div>
          </Row>

          <Row label="Final round to clinch"
            hint={settings.finalRoundToClinch ? 'Reaching FINISH only wins if you scored that round.' : 'First piece to reach FINISH wins outright.'}>
            <Seg options={onOff} value={!!settings.finalRoundToClinch} onChange={(v) => set('finalRoundToClinch', v)} />
          </Row>
          <Row label="Answer reviews"
            hint={settings.allowReviews !== false ? 'A player judged wrong can dispute; the other players vote to overturn it.' : 'The AI ruling is final — no disputes.'}>
            <Seg options={onOff} value={settings.allowReviews !== false} onChange={(v) => set('allowReviews', v)} />
          </Row>
          <Row label="Unverified questions (dev)"
            hint={settings.allowUnverified ? 'Serving drafted questions that are NOT fact-checked yet.' : 'Only verified questions will be served.'}>
            <Seg options={[{ v: false, label: 'Off' }, { v: true, label: 'Allow' }]} value={!!settings.allowUnverified} onChange={(v) => set('allowUnverified', v)} />
          </Row>
        </div>
      </div>
      </div>
    </>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="ad-row">
      <div className="ad-row-label">{label}{hint && <span className="ad-row-hint">{hint}</span>}</div>
      <div className="ad-row-control">{children}</div>
    </div>
  );
}
function StepRow({ label, children }) {
  return <div className="ad-steprow"><span className="ad-steprow-label">{label}</span>{children}</div>;
}
