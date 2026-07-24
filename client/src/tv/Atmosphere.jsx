import React from 'react';

// Layered atmospheric backdrop for the TV view. CSS-only — no asset loads.
//   - Starfield: dozens of static dots in the upper half
//   - Aurora ribbons: two drifting gradient bands across the top
//   - Mountain silhouette: dark jagged horizon
//   - Tree silhouette: a row of pines along the bottom
//   - Fireflies sit on top via the existing Fireflies component
export default function Atmosphere() {
  const stars = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 80; i++) {
      arr.push({
        x: Math.random() * 100,
        y: Math.random() * 55,
        size: Math.random() < 0.85 ? 1.2 : 2.2,
        opacity: 0.35 + Math.random() * 0.5,
        twinkleDelay: Math.random() * 6
      });
    }
    return arr;
  }, []);
  return (
    <div className="tv-atmosphere" aria-hidden="true">
      {/* aurora ribbon 1 */}
      <div className="tv-aurora tv-aurora-1" />
      {/* aurora ribbon 2 */}
      <div className="tv-aurora tv-aurora-2" />
      {/* starfield */}
      <svg className="tv-stars" preserveAspectRatio="none" viewBox="0 0 100 100">
        {stars.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.size * 0.15} fill="#FFF5E1" opacity={s.opacity}>
            <animate
              attributeName="opacity"
              values={`${s.opacity};${s.opacity * 0.3};${s.opacity}`}
              dur="4s"
              begin={`-${s.twinkleDelay}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </svg>
      {/* distant mountains */}
      <svg className="tv-mountains" preserveAspectRatio="none" viewBox="0 0 1200 200">
        <path
          d="M0 200 L0 120 L60 80 L130 110 L210 60 L300 95 L400 50 L500 90 L590 70 L680 100 L780 60 L880 95 L970 75 L1080 110 L1200 70 L1200 200 Z"
          fill="rgba(20, 12, 50, 0.85)"
        />
      </svg>
      {/* near tree silhouette — a row of pines, slightly varied */}
      <svg className="tv-trees" preserveAspectRatio="none" viewBox="0 0 1600 200">
        {pines().map((p, i) => (
          <path
            key={i}
            d={pineShape(p.x, p.h, p.w)}
            fill="rgba(8, 4, 24, 0.95)"
          />
        ))}
      </svg>
    </div>
  );
}

function pines() {
  // Deterministic placement so it doesn't reflow between renders.
  const ps = [];
  let x = -20;
  while (x < 1620) {
    const h = 110 + Math.floor(((x * 7919) % 70));
    const w = 36 + (h - 110) * 0.3;
    ps.push({ x, h, w });
    x += 28 + (h % 12);
  }
  return ps;
}
function pineShape(cx, h, w) {
  const baseY = 200;
  const trunkW = 4;
  // Three tapered triangles stacked: classic conifer silhouette.
  const top = baseY - h;
  const t1 = baseY - h * 0.62;
  const t2 = baseY - h * 0.32;
  return (
    `M${cx - w / 2},${baseY} L${cx + w / 2},${baseY} ` +
    `L${cx + w * 0.42},${t2} L${cx + w * 0.5},${t2} ` +
    `L${cx + w * 0.30},${t1} L${cx + w * 0.36},${t1} ` +
    `L${cx},${top} ` +
    `L${cx - w * 0.36},${t1} L${cx - w * 0.30},${t1} ` +
    `L${cx - w * 0.5},${t2} L${cx - w * 0.42},${t2} Z ` +
    // trunk
    `M${cx - trunkW / 2},${baseY} L${cx + trunkW / 2},${baseY} L${cx + trunkW / 2},${baseY + 4} L${cx - trunkW / 2},${baseY + 4} Z`
  );
}
