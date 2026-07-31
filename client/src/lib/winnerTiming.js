// Winner-screen reveal timeline — the single source of truth for WHEN each
// beat of the celebration lands.
//
// Three systems have to agree to the millisecond or the moment falls apart:
// the DOM reveal (App.jsx drives CSS animation-delay off these numbers), the
// canvas particle engine (Celebration.jsx), and the audio (sfx.celebration).
// They used to each guess; now they all read from here.
//
// All values are milliseconds from the instant GAME_OVER mounts.
//
// The shape of the moment: a dark, quiet hold — then light, then the hit.
// Everything before HERO is anticipation; everything after is payoff. The
// build is deliberately long for a trivia game: a drum roll needs room to
// actually roll before the Tada pays it off.
export const REVEAL = {
  // House lights down. The backdrop deepens and the board dims out.
  DIM: 0,
  // A warm coffeehouse spotlight blooms open where the winner will stand.
  SPOT: 300,
  // Audio-only beat: the reaction line, dropped in just after the applause
  // has established so it lands on top of a crowd rather than on silence.
  REACTION: 500,
  // The crown drops in above the empty spotlight, drum roll building.
  CREST: 700,
  // THE HIT. Winner's piece slams in, shockwave ring, light flare, first
  // shells burst. This is the downbeat everything else is timed against.
  HERO: 1600,
  // Title wipes in under the piece.
  TITLE: 1950,
  // Name, then the stats line.
  NAME: 2250,
  SUB: 2420,
  // Confetti cannons fire and the fireworks settle into their real rhythm.
  CANNON: 2450,
  // Leaderboard rows stagger in and the scores count up.
  BOARD: 2700,
  // Per-row stagger for the leaderboard.
  ROW_STEP: 90,
  // Buttons last, so nobody clicks through the moment before it plays.
  BUTTONS: 3450,
};

// How long the score count-up takes once a row has landed.
export const COUNT_UP_MS = 900;

// The celebration is a moment, not a state: the fireworks thin out and stop
// rather than looping forever at full intensity (which is what made the old
// one exhausting to sit through). After this the screen is calm and the
// leaderboard is the thing you're looking at.
export const FIREWORKS_HEAVY_MS = 7500;   // dense opening volley
export const FIREWORKS_END_MS = 26000;    // last shell goes up around here
