import React from 'react';

// Pure-CSS animated overlays that bring the painted board.png to life:
//   - UFO body + beam: continuous additive glow pulses (mix-blend-mode: screen)
//   - Firewatch tower & lake cabin: warm halo that dims and brightens on top
//     of the board's baked-in window glow, like someone moving past the
//     lamps inside. The two houses are 9s out of phase so the board breathes
//     instead of blinking in unison.
//
// All positions are percentages of the board frame; tune in tv.css if a
// glow drifts off its painted feature.
export default function BoardAmbience() {
  return (
    <div className="tv-board-ambience" aria-hidden="true">
      <div className="ufo-beam-glow" />
      <div className="ufo-body-glow" />
      <div className="house-light house-light--firewatch">
        <div className="house-light-halo" />
      </div>
      <div className="house-light house-light--cabin">
        <div className="house-light-halo" />
      </div>
      {/* The 6 lamp finials along the footbridge arch. Each gets its own
          gentle, out-of-phase flicker (durations/delays set in tv.css) so
          they shimmer like real candles rather than blinking in unison. */}
      <div className="bridge-lights">
        <span className="bridge-light" />
        <span className="bridge-light" />
        <span className="bridge-light" />
        <span className="bridge-light" />
        <span className="bridge-light" />
        <span className="bridge-light" />
      </div>
    </div>
  );
}
