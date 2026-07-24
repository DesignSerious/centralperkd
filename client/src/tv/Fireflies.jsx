import React from 'react';

// Pure-CSS firefly layer. 24 dots with randomized starting positions
// and animation delays so they drift independently.
export default function Fireflies({ count = 24 }) {
  const flies = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        left: Math.random() * 100,
        top: 30 + Math.random() * 70,
        delay: Math.random() * 12,
        duration: 9 + Math.random() * 12,
        size: 3 + Math.random() * 4
      });
    }
    return arr;
  }, [count]);
  return (
    <div className="tv-fireflies" aria-hidden="true">
      {flies.map((f, i) => (
        <span
          key={i}
          className="firefly"
          style={{
            left: f.left + '%',
            top: f.top + '%',
            width: f.size + 'px',
            height: f.size + 'px',
            animationDelay: -f.delay + 's',
            animationDuration: f.duration + 's'
          }}
        />
      ))}
    </div>
  );
}
