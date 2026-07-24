import React from 'react';

// Storybook-themed line-art icons used in place of OS emojis on status
// screens. Each icon layers a soft outer halo + a stitched inner detail +
// a bold central glyph, plus a couple of tiny twinkles, so they read as
// hand-drawn "stamps of approval" rather than flat material icons.
//
// Icons inherit color from `currentColor` so set `color` on the parent
// (the `color` prop here just sets it inline). Default 48px fits the
// existing 2.4rem emoji slots; pass `size` for other layouts.
export default function GameIcon({ name, size = 48, color = 'var(--gold-soft)' }) {
  const stroke = 1.6;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { color, display: 'inline-block' }
  };

  switch (name) {
    case 'check':
      // Approval stamp — bold checkmark inside a stitched gold ring with a
      // soft outer halo and a couple of twinkles. Used after a player
      // submits their bluff; reads as "your card is in the hat."
      return (
        <svg {...common}>
          {/* Soft outer halo */}
          <circle cx="32" cy="32" r="27" strokeOpacity="0.16" />
          {/* Filled disc giving the stamp some weight */}
          <circle cx="32" cy="32" r="22" fill="currentColor" fillOpacity="0.10" />
          {/* Solid outer ring */}
          <circle cx="32" cy="32" r="22" />
          {/* Stitched inner ring */}
          <circle cx="32" cy="32" r="17" strokeDasharray="2 3" strokeOpacity="0.55" />
          {/* The check — bold, slightly chunky, hand-drawn feel */}
          <path d="M22 33 L29 41 L44 24" strokeWidth="4" />
          {/* Sparkle top-right */}
          <path d="M52 13 l1 -3 l1 3 l3 1 l-3 1 l-1 3 l-1 -3 l-3 -1 z" fill="currentColor" />
          {/* Sparkle bottom-left */}
          <path d="M8 50 l0.7 -2 l0.7 2 l2 0.7 l-2 0.7 l-0.7 2 l-0.7 -2 l-2 -0.7 z" fill="currentColor" />
        </svg>
      );

    case 'seal':
      // Wax seal — irregular blob with a crown impression (matches the
      // Wilderdash logo crown). Used for "vote locked in" and as the badge
      // marking the real definition on the reveal cards.
      return (
        <svg {...common}>
          {/* Wax blob — slightly irregular polygon so it reads as a poured stamp */}
          <path
            d="M32 7 L43 11 L51 17 L54 27 L53 38 L47 48 L37 54 L32 56 L27 54 L17 48 L11 38 L10 27 L13 17 L21 11 Z"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <path d="M32 7 L43 11 L51 17 L54 27 L53 38 L47 48 L37 54 L32 56 L27 54 L17 48 L11 38 L10 27 L13 17 L21 11 Z" />
          {/* Stitched inner ring suggesting the die-stamp impression */}
          <circle cx="32" cy="32" r="14" strokeDasharray="2 3" strokeOpacity="0.55" />
          {/* Crown impression — 3-point crown w/ dots, base bar */}
          <path d="M22 36 L25 26 L29 31 L32 22 L35 31 L39 26 L42 36 Z" fill="currentColor" />
          <circle cx="25" cy="24" r="1.2" fill="currentColor" />
          <circle cx="32" cy="20" r="1.2" fill="currentColor" />
          <circle cx="39" cy="24" r="1.2" fill="currentColor" />
          <path d="M21 39 L43 39" strokeWidth="1.6" strokeOpacity="0.75" />
          {/* Tiny highlight glint on the upper left of the wax */}
          <path d="M19 18 q3 -2 7 -2" strokeOpacity="0.45" />
        </svg>
      );

    case 'fireflies':
      // Three layered fireflies (halo + soft mid-ring + bright core) plus
      // a few tiny floating motes. Used on the picker's "waiting on the
      // others to vote" screen.
      return (
        <svg {...common}>
          {/* Big upper-left */}
          <circle cx="20" cy="22" r="8" strokeOpacity="0.16" />
          <circle cx="20" cy="22" r="5" strokeOpacity="0.40" />
          <circle cx="20" cy="22" r="2.5" fill="currentColor" />
          {/* Medium upper-right */}
          <circle cx="46" cy="28" r="6.5" strokeOpacity="0.16" />
          <circle cx="46" cy="28" r="3.5" strokeOpacity="0.40" />
          <circle cx="46" cy="28" r="2" fill="currentColor" />
          {/* Big lower-center */}
          <circle cx="30" cy="44" r="8" strokeOpacity="0.16" />
          <circle cx="30" cy="44" r="5" strokeOpacity="0.40" />
          <circle cx="30" cy="44" r="2.5" fill="currentColor" />
          {/* Floaters */}
          <circle cx="50" cy="50" r="1.6" fill="currentColor" />
          <circle cx="13" cy="46" r="1.2" fill="currentColor" />
          <circle cx="38" cy="14" r="1" fill="currentColor" />
          <circle cx="54" cy="14" r="0.9" fill="currentColor" />
        </svg>
      );

    case 'moon':
      // Crescent moon with a soft cloud wisp + scattered twinkles.
      return (
        <svg {...common}>
          <path d="M44 12 a22 22 0 1 0 0 40 a17 17 0 0 1 0-40 z" fill="currentColor" fillOpacity="0.10" />
          <path d="M44 12 a22 22 0 1 0 0 40 a17 17 0 0 1 0-40 z" />
          {/* Cloud wisp drifting under the moon */}
          <path d="M22 51 q4 -3 9 -2 q3 -3 8 0 q3 -2 7 0" strokeOpacity="0.55" />
          {/* Twinkles */}
          <path d="M14 18 l1 -3 l1 3 l3 1 l-3 1 l-1 3 l-1 -3 l-3 -1 z" fill="currentColor" />
          <path d="M22 40 l0.7 -2 l0.7 2 l2 0.7 l-2 0.7 l-0.7 2 l-0.7 -2 l-2 -0.7 z" fill="currentColor" />
          <path d="M52 22 l0.5 -1.5 l0.5 1.5 l1.5 0.5 l-1.5 0.5 l-0.5 1.5 l-0.5 -1.5 l-1.5 -0.5 z" fill="currentColor" />
        </svg>
      );

    case 'wreath':
      // Laurel wreath crowned with a small crown — winner's reward.
      return (
        <svg {...common}>
          {/* Left laurel arc */}
          <path d="M16 22 Q12 32 16 44 Q22 50 32 50" />
          <path d="M18 26 q-3 1 -3 5" strokeOpacity="0.65" />
          <path d="M15 32 q-3 0 -3 4" strokeOpacity="0.65" />
          <path d="M18 40 q-3 -1 -3 5" strokeOpacity="0.65" />
          <path d="M21 24 q4 0 7 4" fill="currentColor" fillOpacity="0.25" />
          <path d="M21 36 q4 0 7 4" fill="currentColor" fillOpacity="0.25" />
          {/* Right laurel arc */}
          <path d="M48 22 Q52 32 48 44 Q42 50 32 50" />
          <path d="M46 26 q3 1 3 5" strokeOpacity="0.65" />
          <path d="M49 32 q3 0 3 4" strokeOpacity="0.65" />
          <path d="M46 40 q3 -1 3 5" strokeOpacity="0.65" />
          <path d="M43 24 q-4 0 -7 4" fill="currentColor" fillOpacity="0.25" />
          <path d="M43 36 q-4 0 -7 4" fill="currentColor" fillOpacity="0.25" />
          {/* Crown on top */}
          <path d="M22 18 L26 11 L32 16 L38 11 L42 18 Z" fill="currentColor" />
          <circle cx="26" cy="9" r="1.2" fill="currentColor" />
          <circle cx="32" cy="14" r="1.2" fill="currentColor" />
          <circle cx="38" cy="9" r="1.2" fill="currentColor" />
          <path d="M22 20 L42 20" strokeWidth="1.6" />
        </svg>
      );

    case 'thumbup': {
      // Classic neon-glow filled thumbs-up — bright green silhouette with a
      // dark outline and a colored drop-shadow halo. Bypasses the shared
      // {...common} stroke styling because this icon owns its own colors.
      const c = '#5BFF42';
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 20 20"
          style={{
            display: 'inline-block',
            color: c,
            filter: `drop-shadow(0 0 6px ${c}cc) drop-shadow(0 0 14px ${c}66)`
          }}
        >
          <path
            d="M1 8.25a1.25 1.25 0 1 1 2.5 0v7.5a1.25 1.25 0 1 1-2.5 0v-7.5ZM11 3V1.7c0-.268.14-.526.395-.607A2 2 0 0 1 14 3c0 .995-.182 1.948-.514 2.826-.204.54.166 1.174.744 1.174h2.52c1.243 0 2.261 1.01 2.146 2.247a23.864 23.864 0 0 1-1.341 5.974C17.153 16.323 16.072 17 14.9 17h-3.192a3 3 0 0 1-.673-.075l-2.276-.521A3 3 0 0 0 8.078 16.5H7.5V8h.105a3 3 0 0 0 1.97-.741.952.952 0 0 0 .228-.273L11 3Z"
            fill={c}
            stroke="rgba(0, 0, 0, 0.85)"
            strokeWidth="0.6"
            strokeLinejoin="round"
          />
        </svg>
      );
    }

    case 'thumbdown': {
      // Same path as thumbup, rotated 180° around the viewBox center so the
      // thumb points down. Bright red fill with neon glow.
      const c = '#FF4848';
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 20 20"
          style={{
            display: 'inline-block',
            color: c,
            filter: `drop-shadow(0 0 6px ${c}cc) drop-shadow(0 0 14px ${c}66)`
          }}
        >
          <g transform="rotate(180 10 10)">
            <path
              d="M1 8.25a1.25 1.25 0 1 1 2.5 0v7.5a1.25 1.25 0 1 1-2.5 0v-7.5ZM11 3V1.7c0-.268.14-.526.395-.607A2 2 0 0 1 14 3c0 .995-.182 1.948-.514 2.826-.204.54.166 1.174.744 1.174h2.52c1.243 0 2.261 1.01 2.146 2.247a23.864 23.864 0 0 1-1.341 5.974C17.153 16.323 16.072 17 14.9 17h-3.192a3 3 0 0 1-.673-.075l-2.276-.521A3 3 0 0 0 8.078 16.5H7.5V8h.105a3 3 0 0 0 1.97-.741.952.952 0 0 0 .228-.273L11 3Z"
              fill={c}
              stroke="rgba(0, 0, 0, 0.85)"
              strokeWidth="0.6"
              strokeLinejoin="round"
            />
          </g>
        </svg>
      );
    }

    default:
      return null;
  }
}
