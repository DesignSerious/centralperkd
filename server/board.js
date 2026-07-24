// Central Perk'd board definition.
//
// A board is a flat array of spaces: index 0 = START (the doormat), 1..31 =
// the numbered spaces, 32 = FINISH (the couch). Landing on the couch is the
// 32nd move and wins the game.
//
// Space effects fire only when a piece LANDS on them, never when passing over,
// and an effect never chains into a second one — so a single round can't
// cascade a piece across the board.
//
// Tile types map 1:1 onto the artwork:
//
//   plain    parchment square
//   bonus    gold tile with a coffee cup — your NEXT correct answer pays double
//   advance  an arrow painted along the direction of travel: the blue arrow
//            nudges you 1 space, the purple arrows 2. These are relative
//            steps, not jumps to a fixed square.
//   duel     crossed batons — you pick a rival and the next round is scored
//            between the two of you
//
// Nothing on this board sends a piece backwards.

const TYPES = {
  NORMAL: 'normal',
  BONUS: 'bonus',
  ADVANCE: 'advance',
  DUEL: 'duel'
};

// The artwork is 32 moves end to end. Other lengths exist only for quick
// testing — the painted board won't line up with them.
const CANONICAL_LENGTH = 32;
const DEFAULT_LENGTH = 32;
const BOARD_LENGTHS = [16, 32, 48];

// Real positions, read off board1.jpg after the path was traced with
// /tv?calibrate. Each waypoint centre was checked against the painted tiles —
// 3 coffee cups, 2 purple arrows, and the single blue arrow, exactly what the
// art carries. board1.jpg has NO crossed-baton duel tiles (the old board did,
// at 19 and 30) — they're plain parchment now, so no DUEL specials are placed.
// The duel mechanic in game.js stays dormant unless duel tiles are added back
// here. If the board art is ever repainted, re-trace and re-check these.
const CANONICAL_SPECIALS = [
  { index: 5,  type: TYPES.BONUS },              // gold coffee cup
  { index: 9,  type: TYPES.ADVANCE, steps: 2 },  // purple arrow
  { index: 13, type: TYPES.BONUS },              // gold coffee cup
  { index: 17, type: TYPES.ADVANCE, steps: 1 },  // blue arrow
  { index: 24, type: TYPES.ADVANCE, steps: 2 },  // purple arrow
  { index: 27, type: TYPES.BONUS }               // gold coffee cup
];

function buildBoard(length) {
  const n = Math.max(5, Math.round(length) || CANONICAL_LENGTH);
  const spaces = [];
  for (let i = 0; i <= n; i++) spaces.push({ index: i, type: TYPES.NORMAL });

  const scale = (i) => Math.round((i / CANONICAL_LENGTH) * n);

  for (const s of CANONICAL_SPECIALS) {
    const idx = scale(s.index);
    if (idx <= 0 || idx >= n) continue;               // never START or FINISH
    if (spaces[idx].type !== TYPES.NORMAL) continue;  // never stack two specials
    spaces[idx] = s.type === TYPES.ADVANCE
      ? { index: idx, type: TYPES.ADVANCE, steps: s.steps }
      : { index: idx, type: s.type };
  }
  return spaces;
}

// Look up one space, clamped, so callers never have to bounds-check.
function spaceAt(spaces, index) {
  if (!Array.isArray(spaces) || !spaces.length) return { index: 0, type: TYPES.NORMAL };
  const i = Math.max(0, Math.min(spaces.length - 1, Math.round(index) || 0));
  return spaces[i];
}

module.exports = { TYPES, BOARD_LENGTHS, DEFAULT_LENGTH, CANONICAL_LENGTH, buildBoard, spaceAt };
