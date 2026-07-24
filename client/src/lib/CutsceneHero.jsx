import React from 'react';
import PieceVisual from './PieceVisual';

// Renders the "hero image" at the top of a cutscene page (Submitted,
// You know the truth, Picking a word, Announcing, Reading aloud).
//
// Always render the player's piece if they have one (AI piece, photo piece,
// or stock figurine) — PieceVisual picks the right render path per type
// and falls back gracefully if expression variants aren't available. Only
// drop to the static painted scene jpg when there's truly no piece (e.g.
// a player who hasn't picked one yet).
export default function CutsceneHero({ piece, expression, fallbackSrc, alt = '' }) {
  if (piece) {
    return (
      <div className="cutscene-page-figurine-wrap">
        <PieceVisual id={piece} size={200} expression={expression} />
      </div>
    );
  }
  return <img className="cutscene-page-img" src={fallbackSrc} alt={alt} draggable={false} />;
}
