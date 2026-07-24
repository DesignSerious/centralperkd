// Normalize definition text so every player's bluff (and the real
// definition) read uniformly aloud. Removes "tells" like trailing periods,
// stray commas, contractions with apostrophes, etc., so the picker can't
// reveal authorship by reading style. Mirrored server-side in game.js.
//
//   - hyphens / em / en dashes become spaces (keeps word boundaries)
//   - all other punctuation removed (apostrophes, periods, commas, quotes,
//     semicolons, exclamation, question, colons, slashes, parens, etc.)
//   - whitespace collapsed and trimmed
//   - first letter capitalized

export function normalizeDefinitionText(s) {
  if (s == null) return '';
  let text = String(s);
  text = text.replace(/[-–—]/g, ' ');
  text = text.replace(/[^\p{L}\p{N}\s]/gu, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length) text = text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}
