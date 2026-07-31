import React from 'react';

// Vector art for the winner screen, in the show's own visual language.
//
// These exist to get emoji off the TV. The old screen crowned the winner
// with a literal `👑` character, so the centrepiece of the whole game
// rendered as whatever the browser's emoji font felt like, at whatever
// weight, in colours belonging to no part of this design system. On a 65"
// screen that one detail undercut everything around it.
//
// The look is the Friends title card: chunky rounded forms to match Rubik,
// and the red / blue / yellow dots that sit between the letters of the logo.
// Those three colours are the single most recognisable thing about the
// show's graphics, so they carry the win screen instead of generic gold.

// The logo dots, in the order they cycle.
export const DOT_COLORS = ['#E5443A', '#3C74C8', '#F2B830'];

// Each gradient needs a document-unique id — more than one of these can be
// on screen at once and duplicate ids silently cross-wire the fills.
let _uid = 0;
function useId(prefix) {
  return React.useMemo(() => prefix + '-' + (++_uid), [prefix]);
}

// Champion's crown. Deliberately chunky and round-shouldered rather than
// heraldic and spiky — it has to sit next to Rubik without looking like it
// wandered in from a different game.
export function Crown({ className, style }) {
  const gold = useId('crown-gold');
  const rim = useId('crown-rim');
  const shine = useId('crown-shine');
  const body = 'M14 58 Q14 60 16 60 L104 60 Q106 60 106 58 L100 22 Q99 17 95 20 '
    + 'L74 38 Q71 40 69 36 L63 13 Q60 8 57 13 L51 36 Q49 40 46 38 L25 20 '
    + 'Q21 17 20 22 Z';
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 120 82"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gold} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFF3D2" />
          <stop offset="36%" stopColor="#F0CE8E" />
          <stop offset="66%" stopColor="#C79B57" />
          <stop offset="100%" stopColor="#96702F" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFF8E8" />
          <stop offset="52%" stopColor="#E2CB9C" />
          <stop offset="100%" stopColor="#A87F42" />
        </linearGradient>
        {/* Travelling highlight — clipped to the crown, animated in CSS. */}
        <linearGradient id={shine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="46%" stopColor="#FFFFFF" stopOpacity="0.8" />
          <stop offset="54%" stopColor="#FFFFFF" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={shine + '-clip'}>
          <path d={body} />
        </clipPath>
      </defs>

      <path
        d={body}
        fill={'url(#' + gold + ')'}
        stroke="#6B4C1E"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* Band across the base, with the logo dots set into it as jewels —
          the one place the show's colours meet the crown. */}
      <path
        d="M12 59 Q60 53 108 59 L106 74 Q60 68 14 74 Z"
        fill={'url(#' + rim + ')'}
        stroke="#6B4C1E"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="41" cy="64.5" r="3.4" fill={DOT_COLORS[0]} stroke="#6B4C1E" strokeWidth="1.2" />
      <circle cx="60" cy="63.5" r="3.9" fill={DOT_COLORS[1]} stroke="#6B4C1E" strokeWidth="1.2" />
      <circle cx="79" cy="64.5" r="3.4" fill={DOT_COLORS[2]} stroke="#6B4C1E" strokeWidth="1.2" />

      {/* Pearls on the three peaks. */}
      <circle cx="60" cy="9" r="7" fill={'url(#' + rim + ')'} stroke="#6B4C1E" strokeWidth="2.2" />
      <circle cx="21" cy="18" r="5.6" fill={'url(#' + rim + ')'} stroke="#6B4C1E" strokeWidth="2" />
      <circle cx="99" cy="18" r="5.6" fill={'url(#' + rim + ')'} stroke="#6B4C1E" strokeWidth="2" />
      {/* Speculars so the pearls read as spheres, not discs. */}
      <circle cx="57.6" cy="6.6" r="1.9" fill="#FFFFFF" fillOpacity="0.85" />
      <circle cx="19.1" cy="16.1" r="1.5" fill="#FFFFFF" fillOpacity="0.8" />
      <circle cx="97.1" cy="16.1" r="1.5" fill="#FFFFFF" fillOpacity="0.8" />

      <g clipPath={'url(#' + shine + '-clip)'}>
        <rect className="tv-crest-shine" x="-140" y="0" width="120" height="82" fill={'url(#' + shine + ')'} />
      </g>
    </svg>
  );
}

// The title, set the way the show sets its own: one word, spaced out, with
// a coloured dot between every pair of letters. This is the single most
// recognisable device in the Friends graphics package, and it does more for
// "this is Central Perk'd" than any amount of gold gradient.
//
// The word is exposed to assistive tech via aria-label on the wrapper; the
// letters and dots are decorative fragments and stay hidden.
export function DottedTitle({ text, className, style }) {
  const letters = String(text).split('');
  return (
    <div className={className} style={style} role="heading" aria-level="1" aria-label={text}>
      {letters.map((ch, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span
              className="tv-title-dot"
              aria-hidden="true"
              style={{ background: DOT_COLORS[(i - 1) % DOT_COLORS.length] }}
            />
          )}
          <span className="tv-title-letter" aria-hidden="true">{ch}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// Divider under the title: a hairline rule with the three dots set in the
// middle. Echoes the title treatment at a smaller size.
export function DotRule({ className, style }) {
  return (
    <div className={className} style={style} aria-hidden="true">
      <span className="tv-rule-line" />
      {DOT_COLORS.map((c) => (
        <span key={c} className="tv-rule-dot" style={{ background: c }} />
      ))}
      <span className="tv-rule-line" />
    </div>
  );
}

// Ray fan behind the winner. Low-contrast and slow — it gives the hero
// somewhere to stand without competing with it. Generated rather than
// hand-pathed so the count and spread stay easy to tune.
export function Sunburst({ className, style, rays = 24 }) {
  const wedges = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * 360;
    // Alternating widths give the fan a rhythm instead of a flat pinwheel.
    const half = i % 2 === 0 ? 3.6 : 1.8;
    const r = 100;
    const p0 = ((a - half) * Math.PI) / 180;
    const p1 = ((a + half) * Math.PI) / 180;
    wedges.push(
      <path
        key={i}
        d={
          'M60 60 L' + (60 + Math.cos(p0) * r) + ' ' + (60 + Math.sin(p0) * r) +
          ' L' + (60 + Math.cos(p1) * r) + ' ' + (60 + Math.sin(p1) * r) + ' Z'
        }
        fill={i % 2 === 0 ? '#FFF5E1' : '#D7C095'}
      />
    );
  }
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 120 120"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Fades the rays out before they reach the edge, so the fan has no
            hard boundary to give itself away. */}
        <radialGradient id="tv-ray-fade">
          <stop offset="0%" stopColor="#FFF" stopOpacity="0" />
          <stop offset="28%" stopColor="#FFF" stopOpacity="0.75" />
          <stop offset="70%" stopColor="#FFF" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#FFF" stopOpacity="0" />
        </radialGradient>
        <mask id="tv-ray-mask">
          <rect x="0" y="0" width="120" height="120" fill="url(#tv-ray-fade)" />
        </mask>
      </defs>
      <g mask="url(#tv-ray-mask)">{wedges}</g>
    </svg>
  );
}
