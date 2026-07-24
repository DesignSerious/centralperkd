import { useRef, useState, useLayoutEffect } from 'react';

/**
 * Scales its child down (never up past `maxScale`) so the whole thing always
 * fits inside the available width AND height — guaranteeing TV content (the
 * room code, the lobby settings, leaderboards, etc.) never overflows the
 * screen or needs scrolling, no matter the TV size or how much content there
 * is.
 *
 * The outer fills its positioned ancestor (position:absolute; inset:0) and is
 * pointer-events:none so anything behind it (board, top-left buttons) stays
 * clickable; only the scaled inner captures pointer events. The inner's
 * UNscaled layout size (offsetHeight/Width — transforms don't change it) is
 * compared to the outer's content box to pick the scale, so there's no
 * measure/scale feedback loop.
 */
export default function AutoFit({
  children,
  className,
  maxScale = 1,
  // Fraction of the available box to actually use, leaving a little breathing
  // room from the edges (0.94 → ~3% margin each side).
  fill = 0.94,
}) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const availH = outer.clientHeight;
        const availW = outer.clientWidth;
        const h = inner.offsetHeight;
        const w = inner.offsetWidth;
        if (!h || !w || !availH || !availW) return;
        const next = Math.min(maxScale, (availH * fill) / h, (availW * fill) / w);
        setScale(next > 0 ? next : maxScale);
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    measure();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [maxScale, fill]);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <div
        ref={innerRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          flex: '0 0 auto',
          pointerEvents: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  );
}
