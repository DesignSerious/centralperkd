import React, { useEffect, useState } from 'react';

// Bottom-right button that flips the page in/out of true browser fullscreen.
// Uses the standard Fullscreen API with webkit fallbacks for older Safari.
// Renders nothing if the API isn't available (some embedded contexts and
// iOS Safari without the prefixed webkit calls), so it never sits on screen
// as a dead button.

function fsElement() {
  return document.fullscreenElement
      || document.webkitFullscreenElement
      || null;
}
function fsRequest(el) {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  return Promise.reject(new Error('Fullscreen unsupported'));
}
function fsExit() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  return Promise.reject(new Error('Fullscreen unsupported'));
}
function fsSupported() {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

export default function FullscreenToggle() {
  const [isFs, setIsFs] = useState(() => !!fsElement());
  const [supported] = useState(() => fsSupported());

  useEffect(() => {
    if (!supported) return;
    function update() { setIsFs(!!fsElement()); }
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, [supported]);

  if (!supported) return null;

  function toggle() {
    if (fsElement()) {
      fsExit().catch(() => {});
    } else {
      fsRequest(document.documentElement).catch(() => {});
    }
  }

  return (
    <button
      type="button"
      className="tv-fullscreen-btn"
      onClick={toggle}
      aria-label={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
      title={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      {isFs ? (
        // Compress — four arrows pointing inward toward a central square.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 4 V9 H4" />
          <path d="M15 4 V9 H20" />
          <path d="M9 20 V15 H4" />
          <path d="M15 20 V15 H20" />
        </svg>
      ) : (
        // Expand — four arrows pointing outward from the corners.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9 V4 H9" />
          <path d="M20 9 V4 H15" />
          <path d="M4 15 V20 H9" />
          <path d="M20 15 V20 H15" />
        </svg>
      )}
    </button>
  );
}
