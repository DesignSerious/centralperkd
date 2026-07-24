import React, { useEffect, useState } from 'react';
import { useMusic } from './MusicContext';
import MusicSpectrum from './MusicSpectrum';
import * as sfx from './sfx';

// Strip path + .mp3 extension and decode URL-encoded spaces, so a stored
// src like "/audio/Wilderdash%2010.mp3" surfaces as "Wilderdash 10".
function trackNameFromUrl(url) {
  if (!url) return '';
  const last = url.split('/').pop() || '';
  return decodeURIComponent(last.replace(/\.mp3$/i, ''));
}

// Speaker icon + volume sliders + current-track label. Reads/writes the
// shared MusicContext (music) and the shared sfx master (sound effects),
// so every instance on the page (the top-left TV control AND the pause
// overlay's in-card control AND the phone badge slider) stays in sync.
// Renders nothing when no music provider is present (e.g. on the phone),
// so PauseOverlay can mount it unconditionally without leaking a stray
// empty UI there.
//
// When `sfxSliderClass` is supplied the control shows two labeled sliders
// (Music + Sound FX) wrapped in `sliderGroupClass`; without it, it falls
// back to the single music slider for any legacy single-slider caller.
export default function MusicControls({
  controlClass,
  buttonClass,
  sliderClass,
  sfxSliderClass,
  sliderGroupClass,
  trackNavClass,
  vibeNavClass,
  vibeNav,
  spectrumClass
}) {
  const m = useMusic();
  // Mirror the shared sfx master so this slider tracks any change made
  // elsewhere (the phone badge slider, another tab via storage event).
  const [sfxVol, setSfxVol] = useState(() => sfx.getMasterVolume());
  useEffect(() => sfx.subscribeMasterVolume(setSfxVol), []);

  if (!m) return null;
  const { on, setOn, volume, setVolume, trackUrl, prevTrack, nextTrack } = m;
  const trackName = trackNameFromUrl(trackUrl);

  // Vibe (genre) cycler — only the playable options: "All Vibes" (if there
  // are 2+ populated genres) plus every genre that actually has songs.
  const vibeOpts = [];
  if (vibeNav && Array.isArray(vibeNav.vibes)) {
    if (vibeNav.allowAll) vibeOpts.push({ id: '__all__', name: 'All Vibes' });
    for (const v of vibeNav.vibes) {
      if (v && v.tracks && v.tracks.length) vibeOpts.push({ id: v.id, name: v.name });
    }
  }
  const curVibe = vibeOpts.find((o) => o.id === (vibeNav && vibeNav.vibeId)) || vibeOpts[0] || null;
  function stepVibe(dir) {
    if (!vibeNav || vibeOpts.length < 2 || !curVibe) return;
    const i = vibeOpts.findIndex((o) => o.id === curVibe.id);
    const next = ((i < 0 ? 0 : i) + dir + vibeOpts.length) % vibeOpts.length;
    vibeNav.onPickVibe(vibeOpts[next].id);
  }

  const musicSlider = (
    <input
      className={sliderClass}
      type="range" min="0" max="100" step="1"
      value={Math.round(volume * 100)}
      onChange={(e) => setVolume(Math.max(0, Math.min(1, e.target.value / 100)))}
      aria-label="Music volume"
      title="Music volume"
    />
  );
  const sfxSlider = (
    <input
      className={sfxSliderClass}
      type="range" min="0" max="100" step="1"
      value={Math.round(sfxVol * 100)}
      onChange={(e) => sfx.setMasterVolume(Math.max(0, Math.min(1, e.target.value / 100)))}
      aria-label="Sound effects volume"
      title="Sound effects volume"
    />
  );

  return (
    <div className={controlClass}>
      <button
        type="button"
        className={buttonClass + (on ? '' : ' is-off')}
        aria-label="Toggle background music"
        title="Toggle music"
        onClick={() => setOn((v) => !v)}
      >
        <svg className="icon-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z" fill="currentColor" fillOpacity="0.25"/>
          <path d="M16 8.5 C17.5 10 17.5 14 16 15.5"/>
          <path d="M19 6 C21.5 8.5 21.5 15.5 19 18"/>
        </svg>
        <svg className="icon-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z" fill="currentColor" fillOpacity="0.25"/>
          <path d="M17 9 L21 13"/>
          <path d="M21 9 L17 13"/>
        </svg>
      </button>
      {spectrumClass && <MusicSpectrum className={spectrumClass} />}
      {sfxSliderClass ? (
        <div className={sliderGroupClass}>
          <div className="vol-row">
            <span className="vol-row-label">Music</span>
            {musicSlider}
          </div>
          <div className="vol-row">
            <span className="vol-row-label">Sound FX</span>
            {sfxSlider}
          </div>
        </div>
      ) : (
        musicSlider
      )}
      {(() => {
        const trackBlock = trackNavClass && trackName ? (
          <div className={trackNavClass}>
            <button
              type="button"
              className="music-track-prev"
              aria-label="Previous song"
              title="Previous song"
              onClick={prevTrack}
            >‹</button>
            <span className="music-track-name" title={trackName}>{trackName}</span>
            <button
              type="button"
              className="music-track-next"
              aria-label="Next song"
              title="Next song"
              onClick={nextTrack}
            >›</button>
          </div>
        ) : null;
        const vibeBlock = vibeNavClass && vibeOpts.length > 1 && curVibe ? (
          <div className={vibeNavClass}>
            <button
              type="button"
              className="music-track-prev"
              aria-label="Previous vibe"
              title="Previous vibe"
              onClick={() => stepVibe(-1)}
            >‹</button>
            <span className="music-track-name" title={'Vibe: ' + curVibe.name}>{curVibe.name}</span>
            <button
              type="button"
              className="music-track-next"
              aria-label="Next vibe"
              title="Next vibe"
              onClick={() => stepVibe(1)}
            >›</button>
          </div>
        ) : null;
        if (!trackBlock && !vibeBlock) return null;
        // Stack the song selector + vibe selector vertically when both
        // exist; otherwise emit the single block unchanged (keeps the
        // PauseOverlay / legacy single-nav layout exactly as before).
        return vibeBlock
          ? <div className="music-nav-stack">{trackBlock}{vibeBlock}</div>
          : trackBlock;
      })()}
    </div>
  );
}
