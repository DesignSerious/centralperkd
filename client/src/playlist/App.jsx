import React, { useEffect, useRef, useState } from 'react';
import AdminNav from '../lib/AdminNav';
import { loadAdminPwd, saveAdminPwd, clearAdminPwd } from '../lib/adminAuth';

// Central Perk'd playlist admin — sort the music into "vibe" folders (genres).
// Flow:
//   1. Login (PLAYLIST_PASSWORD env, default 'centralperkd'; held in
//      sessionStorage so a refresh doesn't kick you out).
//   2. Editor: the left column is the full song library (every .mp3 on
//      disk). The right column is the genre folders. Drag a song onto a
//      folder to file it there — like dropping a file into a Windows folder.
//      Open a folder to rename it, reorder its songs (drag), remove songs
//      (✕), or mark it the one the TV plays (● Live).
//   3. Save POSTs { activeVibeId, vibes } to /api/playlist; the TV reads it
//      on its next page load.
//
// A folder's stable `id` is what the TV + activeVibeId reference, so renaming
// never changes which playlist is live. A song may live in several folders.
// Songs no longer on disk are dropped on load.
// Seconds → "m:ss" for the preview player's time readout.
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

export default function App() {
  const [password, setPassword] = useState(() => loadAdminPwd());
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authing, setAuthing] = useState(false);

  // Try the saved password on mount.
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
        if (d && d.ok) {
          saveAdminPwd(password);
          setAuthed(true);
        } else {
          setAuthError(d.error || 'Wrong password.');
        }
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
      <div className="pa-shell">
        <div className="pa-card pa-login">
          <h1 className="pa-title">Playlist Admin</h1>
          <p className="pa-sub">Enter the password to manage the music.</p>
          <form onSubmit={login}>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pa-input"
              placeholder="Password"
            />
            {authError && <div className="pa-error">{authError}</div>}
            <button type="submit" className="pa-btn" disabled={authing || !password}>
              {authing ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <Editor password={password} onLogout={logout} />;
}

function Editor({ password, onLogout }) {
  const [allFiles, setAllFiles] = useState(null);
  const [vibes, setVibes] = useState(null);
  const [activeVibeId, setActiveVibeId] = useState(null);
  const [openId, setOpenId] = useState(null);      // expanded folder
  const [dragFile, setDragFile] = useState(null);  // song dragged from library
  const [dropId, setDropId] = useState(null);      // folder being dragged over
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [volumes, setVolumes] = useState({});      // filename -> gain (0..1.5)
  const [uploading, setUploading] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const auth = { Authorization: 'Bearer ' + password };

  // Load disk files + saved vibes, then drop tracks no longer on disk.
  function loadAll() {
    Promise.all([
      fetch('/api/playlist/files').then((r) => r.json()),
      fetch('/api/playlist').then((r) => r.json())
    ]).then(([files, pl]) => {
      const onDisk = (files && files.files) || [];
      const onDiskSet = new Set(onDisk);
      const raw = (pl && Array.isArray(pl.vibes) && pl.vibes.length)
        ? pl.vibes
        : [{ id: 'vibe-1', name: 'Vibe 1', tracks: [] }];
      const cleaned = raw.map((v) => ({
        id: v.id,
        name: v.name,
        tracks: (Array.isArray(v.tracks) ? v.tracks : []).filter((t) => onDiskSet.has(t))
      }));
      const active = cleaned.some((v) => v.id === (pl && pl.activeVibeId))
        ? pl.activeVibeId : cleaned[0].id;
      setAllFiles(onDisk.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
      setVibes(cleaned);
      setActiveVibeId(active);
      setOpenId((o) => o || active);
      setVolumes((pl && pl.volumes && typeof pl.volumes === 'object') ? pl.volumes : {});
    }).catch((e) => setError(e.message));
  }
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, []);

  // ── per-song volume ──
  const volOf = (file) => (typeof volumes[file] === 'number' ? volumes[file] : 1);
  const setVol = (file, g) => setVolumes((v) => ({ ...v, [file]: Math.max(0, Math.min(1.5, g)) }));

  // ── upload ──
  function uploadFiles(list) {
    const mp3s = Array.from(list || []).filter((f) => /\.mp3$/i.test(f.name) || /audio\/mp/.test(f.type));
    if (!mp3s.length) { setError('Only .mp3 files can be uploaded.'); return; }
    setError('');
    setUploading((n) => n + mp3s.length);
    mp3s.forEach((file) => {
      fetch('/api/playlist/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST', headers: { ...auth, 'Content-Type': file.type || 'audio/mpeg' }, body: file
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) throw new Error((d && d.error) || 'Upload failed.');
          // Add to the library without a full reload, so unsaved genre/volume edits survive.
          setAllFiles((prev) => (prev && prev.includes(d.filename)) ? prev
            : (prev || []).concat(d.filename).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
        })
        .catch((e) => setError(e.message))
        .finally(() => setUploading((n) => Math.max(0, n - 1)));
    });
  }
  function onDropZone(e) {
    e.preventDefault(); setDropActive(false);
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }
  // Permanently delete an uploaded song: removes the file server-side and
  // strips it from every genre + its volume, here and on disk.
  function deleteSong(file) {
    if (!window.confirm('Delete "' + file.replace(/\.mp3$/i, '') + '" for good? This removes the file from the server.')) return;
    fetch('/api/playlist/files/' + encodeURIComponent(file), { method: 'DELETE', headers: auth })
      .then((r) => r.json())
      .then((d) => {
        setAllFiles((d && d.files) || ((prev) => (prev || []).filter((f) => f !== file)));
        setVibes((vs) => vs.map((v) => ({ ...v, tracks: v.tracks.filter((t) => t !== file) })));
        setVolumes((vol) => { const n = { ...vol }; delete n[file]; return n; });
        if (previewFile === file && audioRef.current) { audioRef.current.pause(); setPreviewFile(null); }
      })
      .catch((e) => setError(e.message));
  }

  function patchVibe(id, patch) {
    setVibes((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }
  function addTrack(vibeId, file) {
    setVibes((vs) => vs.map((v) =>
      v.id === vibeId && !v.tracks.includes(file)
        ? { ...v, tracks: v.tracks.concat(file) }
        : v));
  }
  function removeTrack(vibeId, file) {
    setVibes((vs) => vs.map((v) =>
      v.id === vibeId ? { ...v, tracks: v.tracks.filter((t) => t !== file) } : v));
  }
  function moveTrack(vibeId, from, to) {
    setVibes((vs) => vs.map((v) => {
      if (v.id !== vibeId) return v;
      const t = v.tracks;
      if (from === to || from < 0 || to < 0 || from >= t.length || to >= t.length) return v;
      const next = t.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { ...v, tracks: next };
    }));
  }

  function save() {
    setSaving(true);
    setError('');
    fetch('/api/playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + password
      },
      body: JSON.stringify({ activeVibeId, vibes, volumes })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) {
          setSavedAt(new Date());
          if (Array.isArray(d.vibes)) {
            setVibes(d.vibes);
            setActiveVibeId(d.activeVibeId);
            setOpenId((o) => (d.vibes.some((v) => v.id === o) ? o : d.activeVibeId));
          }
          if (d.volumes && typeof d.volumes === 'object') setVolumes(d.volumes);
        } else {
          setError(d.error || 'Save failed.');
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  }

  function togglePreview(file) {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewFile === file) {
      audio.pause();
      setPreviewFile(null);
      return;
    }
    audio.src = '/audio/' + encodeURIComponent(file);
    audio.currentTime = 0;
    audio.volume = Math.min(1, volOf(file));   // preview at the song's level (<audio> caps at 1)
    setCurTime(0);
    setDuration(0);
    audio.play()
      .then(() => setPreviewFile(file))
      .catch((err) => {
        setError('Could not play "' + file + '": ' + (err && err.message ? err.message : err));
        setPreviewFile(null);
      });
  }
  // Live-update the preview level as the slider moves.
  useEffect(() => {
    if (audioRef.current && previewFile) audioRef.current.volume = Math.min(1, volOf(previewFile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumes, previewFile]);
  // Pause/resume the track that's already loaded (the player-bar button).
  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio || !previewFile) return;
    if (audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      audio.pause();
    }
  }
  // Scrub: jump to a position (seconds) in the loaded track.
  function seek(seconds) {
    const audio = audioRef.current;
    if (!audio || !isFinite(seconds)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
    setCurTime(audio.currentTime);
  }
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => { setPreviewFile(null); setCurTime(0); };
    const onTime = () => setCurTime(audio.currentTime || 0);
    const onMeta = () => setDuration(isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []);

  if (allFiles == null || vibes == null) {
    return (
      <div className="pa-shell">
        <div className="pa-card">
          {error
            ? <div className="pa-error">Could not load tracks: {error}</div>
            : <div className="pa-loading">Loading tracks…</div>}
        </div>
      </div>
    );
  }

  // Which folders each song already belongs to (for the library chips).
  const membership = {};
  allFiles.forEach((f) => { membership[f] = []; });
  vibes.forEach((v) => v.tracks.forEach((t) => {
    if (membership[t]) membership[t].push(v);
  }));

  return (
    <>
      <AdminNav current="playlist" onSignOut={onLogout} />
      <div className="pa-shell">
      <div className="pa-card pa-card--wide pa-editor">
        <div className="pa-header">
          <h1 className="pa-title">Music Vibes</h1>
          <div className="pa-header-actions">
            <button className="pa-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <div className="pa-help">
          Drag a song from the library onto a genre to file it there. Click a
          genre to open it — rename it, drag songs to reorder, remove (✕), or
          mark it <strong>● Live</strong> (the one the TV plays).
          {savedAt && <span className="pa-saved">{' '}— saved {savedAt.toLocaleTimeString()}</span>}
          {error && <span className="pa-error pa-error-inline"> — {error}</span>}
        </div>

        <div className="pa-cols">
          {/* ── Song library ── */}
          <div className="pa-col pa-col--library">
            <div
              className={'pa-drop' + (dropActive ? ' is-active' : '')}
              onDragOver={(e) => { if (!dragFile) { e.preventDefault(); setDropActive(true); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); }}
              onDrop={onDropZone}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              <span className="pa-drop-text">
                {uploading > 0 ? ('Uploading ' + uploading + '…') : '⬆  Drop mp3s here, or click to add songs'}
              </span>
              <input ref={fileInputRef} type="file" accept="audio/mpeg,.mp3" multiple hidden
                onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <div className="pa-col-head">All songs <span className="pa-col-count">{allFiles.length}</span></div>
            <ul className="pa-library">
              {allFiles.map((file) => {
                const isPlaying = previewFile === file;
                const inVibes = membership[file];
                return (
                  <li
                    key={file}
                    className={'pa-song' +
                      (dragFile === file ? ' pa-song--dragging' : '') +
                      (isPlaying ? ' pa-song--playing' : '')}
                    draggable
                    onDragStart={(e) => {
                      setDragFile(file);
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'copy';
                        e.dataTransfer.setData('text/plain', file);
                      }
                    }}
                    onDragEnd={() => { setDragFile(null); setDropId(null); }}
                  >
                    <button
                      className="pa-row-play"
                      type="button"
                      draggable={false}
                      aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => togglePreview(file)}
                    >
                      {isPlaying ? (
                        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5 L19 12 L7 19.5 Z" /></svg>
                      )}
                    </button>
                    <span className="pa-song-main">
                      <span className="pa-row-name">{file.replace(/\.mp3$/i, '')}</span>
                      {inVibes.length > 0 && (
                        <span className="pa-song-tags">
                          {inVibes.map((v) => (
                            <button
                              key={v.id}
                              type="button"
                              className="pa-tag"
                              title={'In "' + v.name + '" — click to remove'}
                              onClick={() => removeTrack(v.id, file)}
                            >
                              {v.name} <span className="pa-tag-x">✕</span>
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="pa-song-vol" title="Playback volume for this song"
                      draggable={false} onMouseDown={(e) => e.stopPropagation()}>
                      <svg className="pa-vol-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z" /></svg>
                      <input type="range" className="pa-vol-slider" min="0" max="150" step="5"
                        value={Math.round(volOf(file) * 100)} draggable={false}
                        aria-label="Song volume"
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => setVol(file, Number(e.target.value) / 100)} />
                      <span className="pa-vol-pct">{Math.round(volOf(file) * 100)}%</span>
                    </span>
                    <button
                      className="pa-row-delete" type="button" draggable={false}
                      aria-label="Delete song from server" title="Delete this song from the server"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => deleteSong(file)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12" />
                      </svg>
                    </button>
                    <span className="pa-row-handle" aria-hidden="true" title="Drag onto a genre">⋮⋮</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── Genre folders ── */}
          <div className="pa-col pa-col--folders">
            <div className="pa-col-head">Genres</div>
            <div className="pa-folders">
              {vibes.map((v) => {
                const isOpen = v.id === openId;
                const isLive = v.id === activeVibeId;
                const isDrop = v.id === dropId && dragFile != null;
                return (
                  <div
                    key={v.id}
                    className={'pa-folder' +
                      (isOpen ? ' pa-folder--open' : '') +
                      (isLive ? ' pa-folder--live' : '') +
                      (isDrop ? ' pa-folder--drop' : '')}
                    onDragOver={(e) => {
                      if (dragFile == null) return; // only library-song drags
                      e.preventDefault();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                      if (dropId !== v.id) setDropId(v.id);
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget)) return;
                      if (dropId === v.id) setDropId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFile != null) addTrack(v.id, dragFile);
                      setDragFile(null);
                      setDropId(null);
                    }}
                  >
                    <div className="pa-folder-head">
                      <button
                        type="button"
                        className="pa-folder-toggle"
                        aria-label={isOpen ? 'Collapse' : 'Open'}
                        onClick={() => setOpenId(isOpen ? null : v.id)}
                      >
                        <span className="pa-folder-icon">{isOpen ? '📂' : '📁'}</span>
                      </button>
                      <input
                        className="pa-input pa-folder-name"
                        value={v.name}
                        maxLength={40}
                        aria-label="Genre name"
                        placeholder="Genre name"
                        onChange={(e) => patchVibe(v.id, { name: e.target.value })}
                      />
                      <span className="pa-folder-count" title="songs in this genre">{v.tracks.length}</span>
                      {isLive ? (
                        <span className="pa-live-badge" title="The TV plays this genre">● Live</span>
                      ) : (
                        <button
                          type="button"
                          className="pa-btn pa-btn--ghost pa-folder-live"
                          onClick={() => setActiveVibeId(v.id)}
                          title="Make the TV play this genre"
                        >
                          Set live
                        </button>
                      )}
                    </div>

                    {isOpen && (
                      <div className="pa-folder-body">
                        {v.tracks.length === 0 ? (
                          <div className="pa-empty">Empty — drag songs here from the library.</div>
                        ) : (
                          <TrackList
                            tracks={v.tracks}
                            previewFile={previewFile}
                            onMove={(from, to) => moveTrack(v.id, from, to)}
                            onTogglePreview={togglePreview}
                            onRemove={(file) => removeTrack(v.id, file)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <audio ref={audioRef} />
      </div>

      {previewFile && (
        <div className="pa-player">
          <button
            className="pa-row-play"
            type="button"
            aria-label={paused ? 'Resume' : 'Pause'}
            onClick={togglePlayPause}
          >
            {paused ? (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5 L19 12 L7 19.5 Z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
            )}
          </button>
          <span className="pa-player-name">{previewFile.replace(/\.mp3$/i, '')}</span>
          <span className="pa-player-time">{fmtTime(curTime)}</span>
          <input
            className="pa-player-seek"
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(curTime, duration || curTime)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            aria-label="Seek through the track"
            title="Drag to fast-forward / rewind"
          />
          <span className="pa-player-time">{fmtTime(duration)}</span>
          <button
            className="pa-row-remove"
            type="button"
            aria-label="Stop preview"
            title="Stop preview"
            onClick={() => togglePreview(previewFile)}
          >
            ✕
          </button>
        </div>
      )}
      </div>
    </>
  );
}

// An open folder's ordered track list. Native HTML5 drag-drop reorder: each
// row is the drag source; the dragged-over row is the drop target. Drop
// triggers onMove(source, target). Each row has a remove (✕) control. These
// reorder drags are independent of the library→folder song drags.
function TrackList({ tracks, previewFile, onMove, onTogglePreview, onRemove }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  function onDragStart(idx, e) {
    setDragIdx(idx);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  }
  function onDragOver(idx, e) {
    // Only intercept an internal REORDER drag. A library song being filed into
    // this genre (dragIdx == null) must fall through to the folder's drop
    // handler — otherwise stopPropagation here swallows it and only the first
    // (into-an-empty-folder) song ever lands.
    if (dragIdx == null) return;
    e.preventDefault();
    e.stopPropagation(); // don't bubble to the folder's song-drop handler
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (overIdx !== idx) setOverIdx(idx);
  }
  function onDragLeave() { setOverIdx(null); }
  function onDrop(idx, e) {
    if (dragIdx == null) return; // library-song drop → let the folder add it
    e.preventDefault();
    e.stopPropagation();
    onMove(dragIdx, idx);
    setDragIdx(null);
    setOverIdx(null);
  }
  function onDragEnd() {
    setDragIdx(null);
    setOverIdx(null);
  }

  return (
    <ol className="pa-list">
      {tracks.map((file, idx) => {
        const isDragging = dragIdx === idx;
        const isOver = overIdx === idx && dragIdx !== idx;
        const isPlaying = previewFile === file;
        return (
          <li
            key={file}
            className={'pa-row' +
              (isDragging ? ' pa-row--dragging' : '') +
              (isOver ? ' pa-row--over' : '') +
              (isPlaying ? ' pa-row--playing' : '')}
            draggable
            onDragStart={(e) => onDragStart(idx, e)}
            onDragOver={(e) => onDragOver(idx, e)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(idx, e)}
            onDragEnd={onDragEnd}
          >
            <span className="pa-row-rank">{idx + 1}</span>
            <button
              className="pa-row-play"
              type="button"
              draggable={false}
              aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onTogglePreview(file); }}
            >
              {isPlaying ? (
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5 L19 12 L7 19.5 Z" /></svg>
              )}
            </button>
            <span className="pa-row-name">{file.replace(/\.mp3$/i, '')}</span>
            <button
              type="button"
              className="pa-row-remove"
              draggable={false}
              aria-label="Remove from this genre"
              title="Remove from this genre"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onRemove(file); }}
            >
              ✕
            </button>
            <span className="pa-row-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
          </li>
        );
      })}
    </ol>
  );
}
