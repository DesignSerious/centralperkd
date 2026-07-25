import React, { useEffect, useRef, useState } from 'react';
import * as sfx from '../lib/sfx';
import AdminNav from '../lib/AdminNav';
import { loadAdminPwd, saveAdminPwd, clearAdminPwd } from '../lib/adminAuth';

// Central Perk'd Sound Board admin.
// Flow:
//   1. Login using the SHARED admin password (loadAdminPwd), so signing in on
//      any admin page (/admin, /sounds, /playlist) covers them all — the top
//      nav then jumps between tools without re-login.
//   2. Editor: drop mp3s to upload them into the library (left). Drag a library
//      sound onto a trigger card (right) to assign it, or ✕ to reset a trigger
//      to its built-in default. Save writes the trigger→file map to the server;
//      the TV/phone sfx layer reads it on the next page load.
//
// A trigger's stable key is what sfx.js references; renaming/uploading never
// changes which key a sound is bound to. Unassigned triggers use their default.

export default function App() {
  const [password, setPassword] = useState(() => loadAdminPwd());
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authing, setAuthing] = useState(false);

  useEffect(() => {
    if (!password) return;
    setAuthing(true);
    fetch('/api/playlist/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) setAuthed(true);
        else { setPassword(''); clearAdminPwd(); }
      })
      .catch(() => {})
      .finally(() => setAuthing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function login(e) {
    e.preventDefault();
    setAuthError('');
    setAuthing(true);
    fetch('/api/playlist/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) { saveAdminPwd(password); setAuthed(true); }
        else setAuthError((d && d.error) || 'Wrong password.');
      })
      .catch((e) => setAuthError(e.message))
      .finally(() => setAuthing(false));
  }

  function logout() {
    clearAdminPwd();
    setPassword('');
    setAuthed(false);
  }

  if (!authed) {
    return (
      <div className="sb-shell">
        <div className="sb-card sb-login">
          <h1 className="sb-title">Sound Board</h1>
          <p className="sb-sub">Enter the password to manage the game sounds.</p>
          <form onSubmit={login}>
            <input
              type="password" autoFocus value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="sb-input" placeholder="Password"
            />
            {authError && <div className="sb-error">{authError}</div>}
            <button type="submit" className="sb-btn" disabled={authing || !password}>
              {authing ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    );
  }
  return <Editor password={password} onLogout={logout} />;
}

// Turn "/sfx-audio/My%20Sound.mp3" back into "My Sound.mp3".
function fileFromUrl(url) {
  const p = '/sfx-audio/';
  if (typeof url !== 'string' || !url.startsWith(p)) return null;
  try { return decodeURIComponent(url.slice(p.length)); } catch (e) { return url.slice(p.length); }
}
const soundUrl = (file) => '/sfx-audio/' + encodeURIComponent(file);
// Built-in defaults live in /audio/misc; null defaultFile = a synth tone.
const defaultUrlFor = (t) => (t && t.defaultFile ? '/audio/misc/' + encodeURIComponent(t.defaultFile) : null);
const pretty = (file) => (file || '').replace(/\.mp3$/i, '');

function Editor({ password, onLogout }) {
  const [triggers, setTriggers] = useState(null);   // catalog [{key,label,desc,defaultFile}]
  const [assign, setAssign] = useState({});         // key -> filename
  const [volumes, setVolumes] = useState({});       // key -> gain (0..1.5)
  const [files, setFiles] = useState([]);           // library filenames
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [dragFile, setDragFile] = useState(null);   // library file being dragged
  const [dropKey, setDropKey] = useState(null);     // trigger being dragged over
  const [previewUrl, setPreviewUrl] = useState(null);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const auth = { Authorization: 'Bearer ' + password };

  function loadAll() {
    setLoading(true);
    Promise.all([
      fetch('/api/sounds').then((r) => r.json()),
      fetch('/api/sounds/files', { headers: auth }).then((r) => r.json())
    ]).then(([cat, lib]) => {
      setTriggers((cat && cat.triggers) || []);
      const a = {};
      const raw = (cat && cat.assignments) || {};
      Object.keys(raw).forEach((k) => { const f = fileFromUrl(raw[k]); if (f) a[k] = f; });
      setAssign(a);
      setVolumes((cat && cat.volumes) || {});
      setFiles((lib && lib.files) || []);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, []);

  // Per-trigger gain helpers (0..1.5). Absent = 1 (the sound's own level).
  const volOf = (key) => {
    const g = volumes[key];
    return (typeof g === 'number' && isFinite(g)) ? g : 1;
  };
  const setVol = (key, g) => setVolumes((prev) => ({ ...prev, [key]: Math.max(0, Math.min(1.5, g)) }));

  // ── preview player (plays any URL: uploaded /sfx-audio or built-in /audio) ──
  // `vol` previews at the trigger's level; HTMLAudio caps at 1.0.
  function togglePreview(url, vol = 1) {
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (previewUrl === url) { audio.pause(); setPreviewUrl(null); return; }
    audio.src = url;
    audio.currentTime = 0;
    audio.volume = Math.max(0, Math.min(1, vol));
    audio.play().then(() => setPreviewUrl(url)).catch((err) => {
      setError('Could not play that sound: ' + (err && err.message ? err.message : err));
      setPreviewUrl(null);
    });
  }
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => setPreviewUrl(null);
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, []);

  // ── upload ──
  function uploadFiles(list) {
    const mp3s = Array.from(list || []).filter((f) => /\.mp3$/i.test(f.name) || /audio\/mp/.test(f.type));
    if (!mp3s.length) { setError('Only .mp3 files can be uploaded.'); return; }
    setError('');
    setUploading((n) => n + mp3s.length);
    mp3s.forEach((file) => {
      fetch('/api/sounds/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': file.type || 'audio/mpeg' },
        body: file
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) throw new Error((d && d.error) || 'Upload failed.');
          setFiles((prev) => (prev.includes(d.filename) ? prev : prev.concat(d.filename).sort(
            (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))));
        })
        .catch((e) => setError(e.message))
        .finally(() => setUploading((n) => Math.max(0, n - 1)));
    });
  }
  function onDrop(e) {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }
  function deleteFile(file) {
    fetch('/api/sounds/files/' + encodeURIComponent(file), { method: 'DELETE', headers: auth })
      .then((r) => r.json())
      .then((d) => {
        setFiles((d && d.files) || []);
        // Drop any assignment that pointed at the deleted file.
        setAssign((prev) => {
          const next = { ...prev };
          Object.keys(next).forEach((k) => { if (next[k] === file) delete next[k]; });
          return next;
        });
      })
      .catch((e) => setError(e.message));
  }

  // ── assignment ──
  const setTrigger = (key, file) => setAssign((prev) => ({ ...prev, [key]: file }));
  const clearTrigger = (key) => setAssign((prev) => { const n = { ...prev }; delete n[key]; return n; });

  function save() {
    setSaving(true); setError('');
    fetch('/api/sounds', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: assign, volumes })
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) throw new Error((d && d.error) || 'Save failed.');
        // Server may drop invalid entries — mirror what it stored.
        setAssign(d.assignments || {});
        setVolumes(d.volumes || {});
        setSavedAt(new Date());
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  }

  if (loading || triggers == null) {
    return (
      <div className="sb-shell"><div className="sb-card">
        {error ? <div className="sb-error">Could not load: {error}</div> : <div className="sb-loading">Loading…</div>}
      </div></div>
    );
  }

  return (
    <>
      <AdminNav current="sounds" onSignOut={onLogout} />
      <div className="sb-shell">
      <div className="sb-card sb-card--wide">
        <div className="sb-header">
          <h1 className="sb-title">Sound Board</h1>
          <div className="sb-header-actions">
            <button className="sb-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="sb-help">
          Drop <strong>.mp3</strong> files to add them to the library, then drag a sound onto a game
          trigger to assign it. ✕ resets a trigger to its built-in default. Use each trigger's
          <strong> volume</strong> slider to balance how loud that sound plays, and ▶ to hear it.
          {savedAt && <span className="sb-saved"> — saved {savedAt.toLocaleTimeString()}</span>}
          {error && <span className="sb-error sb-error-inline"> — {error}</span>}
        </div>

        <div className="sb-cols">
          {/* ── Library + upload ── */}
          <div className="sb-col sb-col--library">
            <div
              className={'sb-drop' + (dropActive ? ' is-active' : '')}
              onDragOver={(e) => { if (!dragFile) { e.preventDefault(); setDropActive(true); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); }}
              onDrop={onDrop}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              <div className="sb-drop-icon" aria-hidden="true">⬆</div>
              <div className="sb-drop-text">
                {uploading > 0 ? ('Uploading ' + uploading + '…') : 'Drop mp3s here, or click to choose'}
              </div>
              <input
                ref={fileInputRef} type="file" accept="audio/mpeg,.mp3" multiple hidden
                onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            <div className="sb-col-head">Library <span className="sb-count">{files.length}</span></div>
            <ul className="sb-library">
              {files.length === 0 && <li className="sb-empty">No sounds yet — drop some mp3s above.</li>}
              {files.map((file) => (
                <li
                  key={file}
                  className={'sb-song' + (dragFile === file ? ' is-dragging' : '') + (previewUrl === soundUrl(file) ? ' is-playing' : '')}
                  draggable
                  onDragStart={(e) => { setDragFile(file); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', file); } }}
                  onDragEnd={() => { setDragFile(null); setDropKey(null); }}
                >
                  <button className="sb-row-play" type="button" draggable={false}
                    aria-label={previewUrl === soundUrl(file) ? 'Pause' : 'Play'}
                    onMouseDown={(e) => e.stopPropagation()} onClick={() => togglePreview(soundUrl(file))}>
                    {previewUrl === soundUrl(file) ? '❚❚' : '▶'}
                  </button>
                  <span className="sb-song-name">{pretty(file)}</span>
                  <button className="sb-row-remove" type="button" draggable={false} title="Delete file"
                    onMouseDown={(e) => e.stopPropagation()} onClick={() => deleteFile(file)}>✕</button>
                  <span className="sb-row-handle" aria-hidden="true" title="Drag onto a trigger">⋮⋮</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Triggers ── */}
          <div className="sb-col sb-col--triggers">
            <div className="sb-col-head">Game triggers</div>
            <div className="sb-triggers">
              {triggers.map((t) => {
                const custom = assign[t.key];
                const defUrl = defaultUrlFor(t);
                const curUrl = custom ? soundUrl(custom) : defUrl;
                const curName = custom ? pretty(custom) : (t.defaultFile ? pretty(t.defaultFile) : 'Built-in tone');
                const playing = previewUrl != null && previewUrl === curUrl;
                const isDrop = dropKey === t.key && dragFile != null;
                return (
                  <div
                    key={t.key}
                    className={'sb-trigger' + (custom ? ' is-set' : '') + (isDrop ? ' is-drop' : '')}
                    onDragOver={(e) => { if (dragFile == null) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; if (dropKey !== t.key) setDropKey(t.key); }}
                    onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget)) return; if (dropKey === t.key) setDropKey(null); }}
                    onDrop={(e) => { e.preventDefault(); if (dragFile != null) setTrigger(t.key, dragFile); setDragFile(null); setDropKey(null); }}
                  >
                    <div className="sb-trigger-info">
                      <div className="sb-trigger-label">{t.label}</div>
                      <div className="sb-trigger-desc">{t.desc}</div>
                    </div>
                    <div className="sb-trigger-slot">
                      {curUrl ? (
                        <button className="sb-row-play" type="button"
                          aria-label={playing ? 'Pause' : 'Play'} onClick={() => togglePreview(curUrl, volOf(t.key))}>
                          {playing ? '❚❚' : '▶'}
                        </button>
                      ) : (
                        // Built-in synth tone (no file) — play it through the sfx layer.
                        <button className="sb-row-play" type="button"
                          aria-label="Play the built-in tone" title="Play the built-in tone"
                          onClick={() => sfx.playDefaultTone(t.key, volOf(t.key))}>▶</button>
                      )}
                      <span className="sb-trigger-file" title={curName}>{curName}</span>
                      <span className={'sb-badge ' + (custom ? 'is-custom' : 'is-default')}>{custom ? 'Custom' : 'Default'}</span>
                      {custom && (
                        <button className="sb-trigger-clear" type="button" title="Reset to the default sound"
                          onClick={() => clearTrigger(t.key)}>✕</button>
                      )}
                    </div>
                    <div className="sb-trigger-vol">
                      <span className="sb-vol-icon" aria-hidden="true">🔊</span>
                      <input
                        className="sb-vol-slider" type="range" min="0" max="150" step="5"
                        value={Math.round(volOf(t.key) * 100)}
                        onChange={(e) => setVol(t.key, Number(e.target.value) / 100)}
                        aria-label={'Volume for ' + t.label}
                      />
                      <span className="sb-vol-pct">{Math.round(volOf(t.key) * 100)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <audio ref={audioRef} />
      </div>
      </div>
    </>
  );
}
