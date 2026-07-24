import React from 'react';
import { sendAction } from './socket';
import MusicControls from './MusicControls';

// Full-screen "GAME PAUSED" overlay shown on both phone and TV when
// snap.paused === true. Anyone in the room can hit Resume; the server
// re-arms the frozen phase timer with whatever time was left and reschedules
// any pending bot actions. Music keeps playing because it lives entirely on
// the client and nothing here touches the audio elements directly.
//
// On the TV (where MusicProvider exists) we also surface a speaker + volume
// slider inside the card so the user can mute / lower the music while the
// game's frozen — the most likely reason to want pause control. On phones
// the MusicControls renders nothing (no provider, no audio element).
export default function PauseOverlay() {
  function resume() {
    sendAction('resumeGame');
  }
  return (
    <div className="pause-overlay" role="dialog" aria-modal="true" aria-label="Game paused">
      <div className="pause-overlay-card">
        <svg className="pause-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="0.5" />
          <rect x="14" y="5" width="4" height="14" rx="0.5" />
        </svg>
        <div className="pause-overlay-title">Game Paused</div>
        <p className="pause-overlay-body">
          Timers are frozen and CPU players are taking a break.
          The music keeps playing — adjust it below.
        </p>
        <MusicControls
          controlClass="pause-music-control"
          buttonClass="pause-music-toggle"
          sliderClass="pause-music-slider"
          sfxSliderClass="pause-music-slider"
          sliderGroupClass="pause-music-sliders"
          trackNavClass="pause-music-track-nav"
        />
        <button type="button" className="lp-btn" onClick={resume}>Resume</button>
      </div>
    </div>
  );
}
