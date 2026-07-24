import React from 'react';
import { pieceById, isPhotoPiece, isAiPiece, pieceUrlWithExpression, PHOTO_GLOW_COLOR, AI_GLOW_COLOR } from './pieces';

// Renders a player avatar at the requested pixel size. The `id` prop is
// either one of the fixed PIECES ids (renders as figurine PNG / emoji
// fallback), a base64 data URL from a "Take a Photo" capture (renders as a
// circular cropped image), or a /ai-pieces/ URL from the generate-with-AI
// flow (renders like a stock figurine since the image already has its own
// base + transparent background). `size` is the visible side length in
// pixels for photos and the height for figurines (which keep their own
// aspect ratio — they're taller than wide).
//
// `expression` is only meaningful for AI pieces: routes to the matching
// /ai-pieces/{id}-{expression}.png variant if available. onError falls
// back to the neutral piece so a variant that's still generating doesn't
// show a broken image.
export default function PieceVisual({ id, size = 64, glow = false, label = false, expression = 'neutral' }) {
  if (isAiPiece(id)) {
    const glowColor = AI_GLOW_COLOR;
    const src = pieceUrlWithExpression(id, expression);
    return (
      <span className={'piece-visual' + (glow ? ' piece-visual--glow' : '')} style={{ display: 'inline-block', lineHeight: 0 }}>
        <img
          src={src}
          alt="AI piece"
          onError={(e) => {
            // Variant not ready yet (or 404). Fall back to the neutral base.
            if (e.target && e.target.src !== id && !e.target.src.endsWith(id)) {
              e.target.src = id;
            }
          }}
          style={{
            height: size,
            width: 'auto',
            display: 'block',
            filter: glow
              ? `drop-shadow(0 4px 18px ${glowColor}88) drop-shadow(0 0 4px ${glowColor}66)`
              : 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))'
          }}
        />
      </span>
    );
  }
  if (isPhotoPiece(id)) {
    const glowColor = PHOTO_GLOW_COLOR;
    return (
      <span className={'piece-visual piece-visual--photo' + (glow ? ' piece-visual--glow' : '')} style={{ display: 'inline-block', lineHeight: 0 }}>
        <img
          src={id}
          alt="Player photo"
          style={{
            width: size,
            height: size,
            objectFit: 'cover',
            borderRadius: '50%',
            display: 'block',
            filter: glow ? `drop-shadow(0 4px 18px ${glowColor}88) drop-shadow(0 0 4px ${glowColor}66)` : 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))'
          }}
        />
      </span>
    );
  }

  const p = pieceById(id);
  if (!p) return <span style={{ fontSize: size }}>✦</span>;

  if (p.image) {
    return (
      <span className={'piece-visual' + (glow ? ' piece-visual--glow' : '')} style={{ display: 'inline-block', lineHeight: 0 }}>
        <img
          src={p.image}
          alt={p.label}
          style={{
            height: size,
            width: 'auto',
            display: 'block',
            filter: glow ? `drop-shadow(0 4px 18px ${p.color}88) drop-shadow(0 0 4px ${p.color}66)` : 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))'
          }}
        />
        {label && <div className="piece-visual-label">{p.label}</div>}
      </span>
    );
  }
  return <span style={{ fontSize: size * 0.72 }}>{p.emoji}</span>;
}
