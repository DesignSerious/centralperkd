import React from 'react';
import * as sfx from '../lib/sfx';

// Pure-CSS celebration layer for the winner screen: repeating firework
// bursts in the upper half plus confetti raining down the whole frame.
// Decorative only — aria-hidden and pointer-events:none so it never blocks
// the leaderboard/buttons underneath. Positioned absolute:inset-0, so it
// fills whatever positioned ancestor it's dropped into (the board frame).
//
// Each burst's sparks have their outward (tx, ty) offset precomputed here and
// handed to CSS as custom properties, so the keyframes just animate toward
// them — no per-spark keyframes needed.

const FIREWORK_COLORS = [
  '#FFD56B', // gold
  '#FF7A6E', // coral
  '#7ED9B0', // mint
  '#68C58C', // violet
  '#FF9ED2', // pink
  '#9AD0FF', // sky
];

const CONFETTI_COLORS = FIREWORK_COLORS.concat('#FFF3D6');

export default function Celebration({ burstCount = 11, confettiCount = 70 }) {
  // Audio lives with the visual so it covers both the real win and the test
  // preview: a fanfare + an opening volley, then fireworks keep popping until
  // the screen unmounts.
  React.useEffect(() => {
    const handle = sfx.celebrationStart();
    return () => { if (handle && handle.stop) handle.stop(); };
  }, []);

  const bursts = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < burstCount; i++) {
      const sparkCount = 14 + Math.floor(Math.random() * 6);
      const radius = 90 + Math.random() * 90;
      const sparks = [];
      for (let s = 0; s < sparkCount; s++) {
        const angle = (s / sparkCount) * Math.PI * 2 + Math.random() * 0.25;
        const dist = radius * (0.75 + Math.random() * 0.35);
        sparks.push({
          tx: Math.cos(angle) * dist,
          ty: Math.sin(angle) * dist,
        });
      }
      arr.push({
        left: 8 + Math.random() * 84,        // keep bursts off the very edges
        top: 8 + Math.random() * 46,         // upper ~half of the frame
        delay: Math.random() * 4.5,          // staggered so it never syncs
        duration: 2.4 + Math.random() * 1.4,
        color: FIREWORK_COLORS[i % FIREWORK_COLORS.length],
        sparks,
      });
    }
    return arr;
  }, [burstCount]);

  const confetti = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < confettiCount; i++) {
      arr.push({
        left: Math.random() * 100,
        delay: Math.random() * 6,
        duration: 4 + Math.random() * 4,
        size: 7 + Math.random() * 8,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        round: Math.random() < 0.35,
        sway: 12 + Math.random() * 26,
      });
    }
    return arr;
  }, [confettiCount]);

  return (
    <div className="tv-celebration" aria-hidden="true">
      {bursts.map((b, i) => (
        <div
          key={'b' + i}
          className="cel-burst"
          style={{
            left: b.left + '%',
            top: b.top + '%',
            animationDelay: -b.delay + 's',
            animationDuration: b.duration + 's',
          }}
        >
          {b.sparks.map((s, j) => (
            <span
              key={j}
              className="cel-spark"
              style={{
                '--tx': s.tx.toFixed(1) + 'px',
                '--ty': s.ty.toFixed(1) + 'px',
                background: b.color,
                color: b.color,
                animationDelay: -b.delay + 's',
                animationDuration: b.duration + 's',
              }}
            />
          ))}
        </div>
      ))}
      {confetti.map((c, i) => (
        <span
          key={'c' + i}
          className={'cel-confetti' + (c.round ? ' is-round' : '')}
          style={{
            left: c.left + '%',
            width: c.size + 'px',
            height: (c.round ? c.size : c.size * 0.45) + 'px',
            background: c.color,
            animationDelay: -c.delay + 's',
            animationDuration: c.duration + 's',
            '--sway': c.sway + 'px',
          }}
        />
      ))}
    </div>
  );
}
