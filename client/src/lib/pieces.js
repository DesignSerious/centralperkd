// Central Perk'd game pieces (placeholder art borrowed from Wilderdash). The first batch are character figurines (suited
// adults, niche personalities); the second batch are the original cryptid +
// wilderness pieces themed to the board art. The PIECES array order is the
// order tiles appear in the join-screen picker; "Take a Photo" is
// special-cased in Join.jsx and rendered BEFORE this list. Each piece's
// `image` is the rendered figurine PNG; `emoji` is a fallback if the PNG
// is missing.

export const PIECES = [
  { id: 'businessman',   emoji: '👔', label: 'Businessman',     color: '#3B4D7A', image: '/pieces/businessman.png' },
  { id: 'champagne',     emoji: '🥂', label: 'Champagne Girl',  color: '#E8C97A', image: '/pieces/champagne.png' },
  { id: 'racer',         emoji: '🏁', label: 'Racer',           color: '#B33A3A', image: '/pieces/racer.png' },
  { id: 'soosh',         emoji: '🍣', label: 'Soosh',           color: '#C8A878', image: '/pieces/soosh.png' },
  { id: 'pieguy',        emoji: '🍕', label: 'Pie Guy',         color: '#C2452A', image: '/pieces/pieguy.png' },
  { id: 'businesswoman', emoji: '💼', label: 'Businesswoman',   color: '#D4B575', image: '/pieces/businesswoman.png' },
  { id: 'dj',            emoji: '🎧', label: 'DJ',              color: '#7A4FAA', image: '/pieces/dj.png' },
  { id: 'metalmaniac',   emoji: '🤘', label: 'Metal Maniac',    color: '#A22020', image: '/pieces/metalmaniac.png' },
  { id: 'juicyjilz',     emoji: '🎤', label: 'Juicy Jilz',      color: '#E89AB8', image: '/pieces/juicyjilz.png' },
  { id: 'lantern',       emoji: '🏮', label: 'Lantern',         color: '#FFB845', image: '/pieces/lantern.png' },
  { id: 'sasquatch',     emoji: '🦍', label: 'Sasquatch',       color: '#A07A4F', image: '/pieces/sasquatch.png' },
  { id: 'ufo',           emoji: '🛸', label: 'UFO',             color: '#5FD4A8', image: '/pieces/ufo.png' },
  { id: 'compass',       emoji: '🧭', label: 'Compass',         color: '#C9A36B', image: '/pieces/compass.png' },
  { id: 'campfire',      emoji: '🔥', label: 'Campfire',        color: '#FF7A3D', image: '/pieces/campfire.png' },
  { id: 'mothman',       emoji: '🦋', label: 'Mothman',         color: '#E84A4A', image: '/pieces/mothman.png' },
  { id: 'tower',         emoji: '🗼', label: 'Ranger Tower',    color: '#D4B08C', image: '/pieces/tower.png' },
  { id: 'mushroom',      emoji: '🍄', label: 'Mushroom Spirit', color: '#C18BE8', image: '/pieces/mushroom.png' }
];

export function pieceById(id) {
  return PIECES.find((p) => p.id === id) || null;
}

export function pieceEmoji(id) {
  const p = pieceById(id);
  return p ? p.emoji : '✦';
}

// A "piece" value can either be one of the fixed PIECES ids above, a base64
// data URL from the "Take a Photo" flow, or a server-relative URL from the
// "Generate with AI" flow (path starts with /ai-pieces/). These helpers
// discriminate across all three. The rendering pipeline (PieceVisual,
// Board2D, PlayerBadge) and the server's piece validation use them.
export function isPhotoPiece(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}
export function isAiPiece(value) {
  return typeof value === 'string' && value.startsWith('/ai-pieces/');
}
export function isCustomPiece(value) {
  return isPhotoPiece(value) || isAiPiece(value);
}

// Warm gold drop-shadow used for photo-piece glows (no per-photo color is
// available, so we use a single house color that matches the lodge palette).
export const PHOTO_GLOW_COLOR = '#FFB845';
// AI pieces match the figurine style and look natural with the same warm glow.
export const AI_GLOW_COLOR = '#FFB845';

// AI pieces are now a single base image only — the per-expression pose
// variants (submitted / truth / book / megaphone) were dropped along with
// the big cutscene figurines that used them, so the server no longer
// generates them. These two helpers are kept (callers still reference
// them) but always resolve to the single base piece and never request a
// variant URL.
export function pieceUrlWithExpression(value /* , expression */) {
  // Only ever the base piece now; expression is intentionally ignored.
  return value;
}

// No-op: there are no expression variants to preload anymore. Kept so
// existing callers (phone/tv App) don't need to change; prevents the old
// 404-retry storm for variants that are no longer generated.
export function preloadAiPiece() {}

// All game states now use the single neutral piece. Kept for callers that
// still pass it through pieceUrlWithExpression (which ignores it anyway).
export function expressionForState(/* state */) {
  return 'neutral';
}
