import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

// Shared TV-side music state. The provider owns the <audio> element and
// drives playlist rotation; the on/volume state is exposed via context so
// any descendant (the top-left controls AND the in-pause-overlay controls)
// can read and write to the same single source of truth.
//
// Phone does NOT wrap itself in this provider, so useMusic() returns null
// there — components like MusicControls render nothing in that case.
const MusicContext = createContext(null);

export function useMusic() {
  return useContext(MusicContext);
}

// `rotationKey` identifies the current track source (e.g. the selected music
// "vibe"). When it changes, the rotation is rebuilt from the latest
// buildRotation and playback jumps to the new vibe's first track — this is
// how the lobby genre picker swaps the music live.
export function MusicProvider({ buildRotation, rotationKey, storageKeyOn, storageKeyVolume, leadTrackUrl, trackVolumes, children }) {
  const audioRef = useRef(null);
  // Latest per-song gain map (filename -> gain). A ref so a new object each
  // render doesn't retrigger the volume effect; only the track/volume changing does.
  const trackVolumesRef = useRef(trackVolumes);
  trackVolumesRef.current = trackVolumes;
  const rotationRef = useRef(buildRotation());
  const trackIdxRef = useRef(0);
  // Always call through the latest buildRotation (the App passes a fresh
  // closure when the selected vibe changes); refs keep end-of-rotation
  // reshuffles and the switch effect using the current track source.
  const buildRotationRef = useRef(buildRotation);
  buildRotationRef.current = buildRotation;
  const didMountRef = useRef(false);

  // Web Audio graph. Wired lazily on the first user gesture so we don't
  // create a MediaElementSource into a suspended AudioContext (which would
  // silence playback). Once wired:
  //   audio → MediaElementSource → AnalyserNode → GainNode → destination
  // The GainNode is the authoritative volume control once wiring happens.
  // Browsers are inconsistent about whether audio.volume still affects
  // output after a MediaElementSource taps the element, so we route
  // everything through the gain node and pin audio.volume = 1.0 from then on.
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const analyserRef = useRef(null);
  const gainRef = useRef(null);
  function ensureAnalyserWired() {
    if (sourceRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { audioCtxRef.current = new AC(); } catch (e) { return; }
    }
    const ctx = audioCtxRef.current;
    function wire() {
      if (sourceRef.current) return;
      let source;
      try { source = ctx.createMediaElementSource(audio); }
      catch (e) { return; }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      const gain = ctx.createGain();
      // Seed the gain node at the CURRENT effective volume so wiring
      // doesn't cause a level jump.
      gain.gain.value = audio.volume;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      sourceRef.current = source;
      analyserRef.current = analyser;
      gainRef.current = gain;
      // Hand volume control over to the gain node from here on.
      audio.volume = 1.0;
    }
    if (ctx.state === 'suspended') {
      ctx.resume().then(wire).catch(() => {});
    } else {
      wire();
    }
  }

  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(storageKeyOn) !== '0'; }
    catch (e) { return true; }
  });
  // Latest `on` for the first-gesture autostart handler (its effect runs once
  // with [] deps, so it would otherwise capture a stale value).
  const onRef = useRef(on);
  onRef.current = on;
  const [volume, setVolume] = useState(() => {
    try {
      const v = localStorage.getItem(storageKeyVolume);
      if (v === null) return 1.0;
      return Math.max(0, Math.min(1, parseFloat(v)));
    } catch (e) { return 1.0; }
  });
  // Currently-playing track URL, exposed so MusicControls can show the
  // song name to the user when the speaker control is open.
  const [trackUrl, setTrackUrl] = useState(() => rotationRef.current[trackIdxRef.current]);

  // Initial track + rotation handling. Only runs once on mount.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Open the session with the theme track so the first thing heard the
    // moment music starts is the title song, then continue the rotation. Only
    // forced here on mount — a live vibe switch (below) still jumps straight to
    // the chosen genre. If the theme is already in the rotation it's moved to
    // the front; if not (a vibe that doesn't include it), it's prepended so it
    // plays once, then the rotation continues normally.
    if (leadTrackUrl) {
      const rot = rotationRef.current.slice();
      const i = rot.indexOf(leadTrackUrl);
      if (i > 0) { rot.splice(i, 1); rot.unshift(leadTrackUrl); }
      else if (i < 0) { rot.unshift(leadTrackUrl); }
      rotationRef.current = rot;
      trackIdxRef.current = 0;
    }
    audio.volume = volume;
    // No music installed yet (empty rotation) → leave src unset. Assigning
    // undefined makes the browser fetch "/undefined" and log a 404 on every
    // load, which is noise that hides real asset problems.
    const first = rotationRef.current[trackIdxRef.current];
    if (first) {
      audio.src = first;
      setTrackUrl(first);
    }
    function onEnded() {
      trackIdxRef.current += 1;
      if (trackIdxRef.current >= rotationRef.current.length) {
        rotationRef.current = buildRotationRef.current();
        trackIdxRef.current = 0;
      }
      const next = rotationRef.current[trackIdxRef.current];
      if (!next) return; // nothing installed to play
      audio.src = next;
      setTrackUrl(next);
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live vibe switch: when rotationKey changes (the lobby genre picker), drop
  // the old rotation, build the new vibe's, and jump to its first track.
  // Skips the initial mount — the effect above already set the first track.
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const audio = audioRef.current;
    if (!audio) return;
    rotationRef.current = buildRotationRef.current();
    trackIdxRef.current = 0;
    const url = rotationRef.current[trackIdxRef.current];
    if (!url) return; // empty vibe — nothing to switch to
    audio.src = url;
    setTrackUrl(url);
    if (on) {
      ensureAnalyserWired();
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotationKey]);

  // Persist user volume preference. Kept separate from audio.volume push so
  // duck-only changes don't write to localStorage.
  useEffect(() => {
    try { localStorage.setItem(storageKeyVolume, String(volume)); }
    catch (e) {}
  }, [volume, storageKeyVolume]);

  // Optional ducking — temporarily pin the audio output to a ceiling
  // (e.g. 0.15 during the read-aloud phase) without touching the user's
  // saved preference. null = not ducked. Game UI can call setDuckLevel()
  // via context to fade the music down for moments where attention should
  // be on the screen, then setDuckLevel(null) to restore.
  const [duckLevel, setDuckLevel] = useState(null);
  // Push effective volume. Once the gain node is wired, use Web Audio's
  // built-in scheduling for smooth, glitch-free fades. Pre-wiring (before
  // the first user gesture) we fall back to direct audio.volume control.
  // Slider tweaks (small delta) snap immediately; duck transitions (large
  // delta) ramp over 700ms for a graceful musical fade.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Per-song gain (set in the /playlist admin) multiplies the effective
    // volume so one loud track can be levelled against a quiet one. Keyed by
    // filename; the current song's name comes off the playing URL.
    let songGain = 1;
    const vols = trackVolumesRef.current;
    if (vols && trackUrl) {
      const name = decodeURIComponent(String(trackUrl).split('/').pop() || '');
      if (typeof vols[name] === 'number' && isFinite(vols[name])) songGain = vols[name];
    }
    const base = duckLevel != null ? Math.min(volume, duckLevel) : volume;
    const target = base * songGain;
    const gain = gainRef.current;
    const ctx = audioCtxRef.current;
    if (gain && ctx) {
      const now = ctx.currentTime;
      const current = gain.gain.value;
      const isBigChange = Math.abs(current - target) > 0.08;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(current, now);
      if (isBigChange) {
        gain.gain.linearRampToValueAtTime(target, now + 0.7);
      } else {
        gain.gain.setValueAtTime(target, now);
      }
    } else {
      audio.volume = Math.min(1, target); // <audio> caps at 1; gain node handles boost post-gesture
    }
  }, [volume, duckLevel, trackUrl]);

  // Toggle play/pause + persist.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (on) {
      ensureAnalyserWired();
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      audio.pause();
    }
    try { localStorage.setItem(storageKeyOn, on ? '1' : '0'); }
    catch (e) {}
  }, [on, storageKeyOn]);

  // Catch the first real user gesture anywhere on the page and (a) wire up the
  // analyzer graph and (b) START PLAYBACK. Browsers block autoplay until a
  // gesture, so the on-mount play() above silently fails — without this the
  // music wouldn't begin until the user manually toggled the speaker. The
  // first interaction (picking a vibe, adding a bot, clicking "Start the
  // Game", a remote button) now kicks the music off automatically. The
  // AudioContext also can't leave the suspended state pre-gesture, so the
  // spectrum would otherwise stay flat too.
  useEffect(() => {
    function tryWire() {
      ensureAnalyserWired();
      // Start the music on this first gesture if it's enabled and not already
      // playing. Respects a saved "muted" preference (onRef === false).
      if (onRef.current) {
        const audio = audioRef.current;
        if (audio && audio.paused) {
          const p = audio.play();
          if (p && p.catch) p.catch(() => {});
        }
      }
      if (sourceRef.current) {
        window.removeEventListener('pointerdown', tryWire);
        window.removeEventListener('keydown', tryWire);
      }
    }
    window.addEventListener('pointerdown', tryWire);
    window.addEventListener('keydown', tryWire);
    return () => {
      window.removeEventListener('pointerdown', tryWire);
      window.removeEventListener('keydown', tryWire);
    };
  }, []);

  // Autostart as EARLY as the browser allows — ideally the moment the TV
  // screen loads, with no speaker toggle. Chrome blocks audible autoplay until
  // the origin has user-interaction history or a high-enough media-engagement
  // score; a TV that opens wilderdash.com regularly clears that bar. So rather
  // than giving up after the single on-mount play() (which may be rejected on a
  // cold load), we keep retrying — on a short timer, when the audio is ready to
  // play, and when the tab becomes visible — until playback actually starts.
  // The gesture handler above remains the guaranteed fallback for a brand-new
  // browser profile with no engagement history yet.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let tries = 0;
    let iv = 0;
    function attempt() {
      if (!onRef.current) return;        // respect a saved "muted" choice
      if (!audio.paused) { stop(); return; }
      ensureAnalyserWired();
      const p = audio.play();
      if (p && p.then) p.then(() => stop()).catch(() => {});
    }
    function stop() {
      if (iv) { clearInterval(iv); iv = 0; }
      audio.removeEventListener('canplay', attempt);
      document.removeEventListener('visibilitychange', attempt);
    }
    iv = setInterval(() => {
      tries += 1;
      attempt();
      if (tries > 120 || !audio.paused) stop();  // give up after ~72s
    }, 600);
    audio.addEventListener('canplay', attempt);
    document.addEventListener('visibilitychange', attempt);
    attempt();
    return stop;
  }, []);

  // Manual track navigation (prev/next buttons in MusicControls). Updates
  // the live audio element AND the trackUrl state in lockstep, and only
  // calls play() when music is currently on so flipping through tracks while
  // muted respects the user's mute preference.
  function prevTrack() {
    const audio = audioRef.current;
    if (!audio) return;
    trackIdxRef.current -= 1;
    if (trackIdxRef.current < 0) {
      trackIdxRef.current = rotationRef.current.length - 1;
    }
    const url = rotationRef.current[trackIdxRef.current];
    if (!url) return; // empty vibe — nothing to switch to
    audio.src = url;
    setTrackUrl(url);
    if (on) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
  }
  function nextTrack() {
    const audio = audioRef.current;
    if (!audio) return;
    trackIdxRef.current += 1;
    if (trackIdxRef.current >= rotationRef.current.length) {
      // End of rotation: build a fresh shuffle and resume from index 0.
      rotationRef.current = buildRotationRef.current();
      trackIdxRef.current = 0;
    }
    const url = rotationRef.current[trackIdxRef.current];
    if (!url) return; // empty vibe — nothing to switch to
    audio.src = url;
    setTrackUrl(url);
    if (on) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  return (
    <MusicContext.Provider value={{ on, setOn, volume, setVolume, trackUrl, prevTrack, nextTrack, analyserRef, setDuckLevel }}>
      <audio ref={audioRef} preload="auto" />
      {children}
    </MusicContext.Provider>
  );
}
