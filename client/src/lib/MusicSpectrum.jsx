import React, { useEffect, useRef } from 'react';
import { useMusic } from './MusicContext';

// Tiny audio spectrum next to the speaker icon. Reads the live AnalyserNode
// from MusicContext (lazily wired on first user gesture) and draws frequency
// bars to a canvas at ~60fps. When music is off or the analyser hasn't
// wired yet, bars decay smoothly to a flat baseline so the widget never
// pops on/off — it just goes quiet.
//
// Renders nothing if there's no MusicProvider in the tree (phone), so it
// can be mounted unconditionally inside MusicControls.

const BARS = 16;
const BAR_W = 3;
const GAP = 2;
const W = BARS * (BAR_W + GAP) - GAP;
const H = 22;

export default function MusicSpectrum({ className }) {
  const m = useMusic();
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!m) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const levels = new Array(BARS).fill(0);
    let buf = null;
    let raf = 0;

    function frame() {
      raf = requestAnimationFrame(frame);
      const analyser = m.analyserRef && m.analyserRef.current;
      if (analyser && m.on) {
        if (!buf || buf.length !== analyser.frequencyBinCount) {
          buf = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(buf);
        // Sample the lower ~70% of the spectrum where music energy lives;
        // the very top end is mostly silence and would leave the right-most
        // bars permanently dead.
        const usable = Math.floor(buf.length * 0.7);
        for (let i = 0; i < BARS; i++) {
          const bin = Math.min(usable - 1, Math.floor((i + 0.5) * usable / BARS));
          const v = buf[bin] / 255;
          // Gentle perceptual curve — quiet music still moves the bars.
          const shaped = Math.pow(v, 0.7);
          // Smooth upward with the analyser's smoothing; let downward
          // glide a touch slower so peaks linger instead of stuttering.
          levels[i] = shaped > levels[i] ? shaped : levels[i] * 0.88;
        }
      } else {
        // Idle decay to flat.
        for (let i = 0; i < BARS; i++) levels[i] *= 0.86;
      }

      ctx.clearRect(0, 0, W, H);

      // Spectrum length tracks the music volume (the analyser taps the
      // signal BEFORE the gain node, so it's otherwise volume-independent).
      // At volume 0 the widget shows nothing at all.
      const vol = Math.max(0, Math.min(1, m.volume == null ? 1 : m.volume));
      if (vol <= 0) return; // muted → no spectrum bars

      const grad = ctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0,    '#5b2ea3'); // deep amethyst base
      grad.addColorStop(0.55, '#a87bdd'); // bright purple mid
      grad.addColorStop(1,    '#7ad4ff'); // electric sky-blue tip
      ctx.fillStyle = grad;

      for (let i = 0; i < BARS; i++) {
        const v = levels[i];
        const bh = Math.max(1.5, v * H) * vol;
        const x = i * (BAR_W + GAP);
        const y = H - bh;
        ctx.fillRect(x, y, BAR_W, bh);
      }
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [m]);

  if (!m) return null;
  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      className={className}
      aria-hidden="true"
    />
  );
}
