import React from 'react';
import * as sfx from '../lib/sfx';
import { REVEAL, FIREWORKS_HEAVY_MS, FIREWORKS_END_MS } from '../lib/winnerTiming';

// Winner celebration — a canvas particle system for the game-over screen.
//
// This replaces a CSS version whose bursts were fixed-position elements on
// `animation-iteration-count: infinite`: the same firework re-detonated in
// the same spot forever, confetti fell in dead-straight lines, and none of
// it ever ended. Real pyro doesn't repeat and doesn't loop, so this runs an
// actual simulation instead — shells that launch, arc, and burst wherever
// they happen to reach, sparks under gravity and air drag, confetti with
// tumble and flutter, and an intensity curve that peaks and then settles.
//
// Two canvases, one rAF loop:
//   back  (z-index 4) — fireworks, BEHIND the winner card, so the card
//                       always stays readable and the sky has depth.
//   front (z-index 7) — confetti + streamers, in FRONT of the card, which
//                       is where paper physically would be.
//
// The back canvas keeps its trails by erasing itself slightly each frame
// (destination-out) rather than clearing, which is what gives the sparks
// their comet tails on a transparent canvas. The front canvas clears fully
// — confetti with smeared trails looks like a bug, not motion blur.
//
// Both are aria-hidden + pointer-events:none, and sized to the board frame
// (their positioned ancestor), so nothing here can block Play Again.

// Title-card palette. The old version fired rainbow candy colours that
// belonged to no other screen in the app; these are the show's own — the
// red / blue / yellow dots that sit between the letters of the logo, over
// the game's cream and gold.
//
// The dot colours are pushed brighter than their flat-art values because
// sparks draw with additive blending, where a mid-tone reads muddy.
const SPARK_COLORS = [
  [255, 248, 232], // cream-white core
  [255, 236, 190], // warm champagne
  [255, 96, 84],   // logo red
  [255, 206, 82],  // logo yellow
  [104, 168, 255], // logo blue
];
// Cream and gold carry the field; the dot colours punctuate it. Weighted by
// how often each appears in the list.
const CONFETTI_COLORS = [
  '#FFF5E1', // cream
  '#FFF5E1',
  '#F3E2BC',
  '#D7C095', // gold-soft
  '#B78F53', // gold
  '#E5443A', // logo red
  '#F2B830', // logo yellow
  '#3C74C8', // logo blue
];

// One extra accent, kept sparse so the field stays warm rather than turning
// into a generic party popper.
const ACCENT_COLOR = '#7BD9B8'; // --mint
const ACCENT_CHANCE = 0.03;

// Soft caps. A smart-TV browser is not a gaming PC; past these the frame
// budget matters more than the extra sparkle, which nobody can count anyway.
const MAX_SPARKS = 1400;
const MAX_CONFETTI = 520;

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

export default function Celebration() {
  const backRef = React.useRef(null);
  const frontRef = React.useRef(null);

  // Audio lives with the visual so the two can't drift apart and so a
  // future test-preview of this component is fully self-contained.
  React.useEffect(() => {
    const handle = sfx.celebrationStart();
    return () => { if (handle && handle.stop) handle.stop(); };
  }, []);

  React.useEffect(() => {
    const back = backRef.current;
    const front = frontRef.current;
    if (!back || !front) return;

    // Respect the OS setting: no simulation at all, just one calm static
    // scatter so the screen still reads as celebratory without motion.
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const bctx = back.getContext('2d');
    const fctx = front.getContext('2d');
    if (!bctx || !fctx) return;

    let w = 0;
    let h = 0;

    // Work in CSS pixels and let the transform handle device pixel ratio,
    // so all the physics constants below stay in one readable unit.
    function resize() {
      const parent = back.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Cap DPR at 2 — a 4K TV at DPR 3 quadruples fill cost for no
      // visible gain on soft-edged particles.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      [back, front].forEach((cv) => {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px';
        cv.style.height = h + 'px';
      });
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    const ro = new ResizeObserver(resize);
    if (back.parentElement) ro.observe(back.parentElement);

    if (reduced) {
      drawStatic();
      return () => ro.disconnect();
    }

    // ─── State ───
    const shells = [];   // rising, pre-burst
    const sparks = [];   // burst debris
    const confetti = [];
    const flashes = [];  // brief full-frame light bloom on a big burst

    // ─── Physics ───
    // Gravity scales with frame height so the arcs look identical on a
    // laptop preview and a 75" TV.
    const gSpark = () => h * 0.34;
    const gShell = () => h * 0.62;
    const gConf = () => h * 0.52;

    // ─── Fireworks ───

    function launchShell(opts) {
      const o = opts || {};
      // Launch from just off the bottom, angled slightly toward center so
      // shells never march off the sides.
      const x = rand(w * 0.12, w * 0.88);
      const centerBias = (w / 2 - x) * rand(0.06, 0.22);
      // Apex height picked first, then the exact velocity that reaches it.
      const rise = rand(h * 0.42, h * 0.74);
      const vy = -Math.sqrt(2 * gShell() * rise);
      shells.push({
        x,
        y: h * 1.04,
        vx: centerBias,
        vy,
        color: o.color || pick(SPARK_COLORS),
        // Bigger shells for the opening volley; the whistle rides with them.
        power: o.power != null ? o.power : rand(0.85, 1.15),
        type: o.type || pick(['peony', 'peony', 'willow', 'ring', 'crackle']),
        emit: 0,
      });
    }

    // Burst a shell into sparks. Each type has a different velocity
    // distribution and decay, which is what makes them read as different
    // fireworks rather than one effect at different sizes.
    function burst(s) {
      const base = Math.min(w, h) * 0.5 * s.power;
      let count = Math.round(rand(56, 88) * s.power);
      if (sparks.length > MAX_SPARKS * 0.7) count = Math.round(count * 0.5);

      // Ring bursts are planar: pick a random plane and squash one axis so
      // the sphere reads as a disc seen at an angle.
      const ringTilt = rand(0.18, 0.5);
      const ringRot = rand(0, Math.PI);

      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rand(-0.06, 0.06);
        // sqrt of a uniform gives an even fill of the disc instead of a
        // dense clump in the middle.
        let speed = base * (0.35 + Math.sqrt(Math.random()) * 0.65);
        let vx = Math.cos(a) * speed;
        let vy = Math.sin(a) * speed;

        if (s.type === 'ring') {
          const r = base * rand(0.88, 1.0);
          const px = Math.cos(a) * r;
          const py = Math.sin(a) * r * ringTilt;
          vx = px * Math.cos(ringRot) - py * Math.sin(ringRot);
          vy = px * Math.sin(ringRot) + py * Math.cos(ringRot);
        }

        const willow = s.type === 'willow';
        sparks.push({
          x: s.x,
          y: s.y,
          vx,
          vy,
          // Willows hang and drip; peonies snap out and die fast.
          life: 0,
          max: willow ? rand(2.0, 3.1) : rand(0.85, 1.6),
          drag: willow ? 1.5 : 2.6,
          gmul: willow ? 1.5 : 1,
          color: s.color,
          size: rand(1.4, 2.9) * (willow ? 0.85 : 1),
          // Crackle shells glitter: sparks flicker on and off as they fall.
          twinkle: s.type === 'crackle' ? rand(14, 30) : 0,
          phase: rand(0, 6.283),
        });
      }

      // A few slow, heavy embers on every shell — the bits that outlive the
      // burst and drift down. Cheap, and they sell the scale.
      const embers = Math.round(rand(5, 11));
      for (let i = 0; i < embers; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = base * rand(0.1, 0.34);
        sparks.push({
          x: s.x, y: s.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(2.6, 4.2),
          drag: 1.1, gmul: 0.85,
          color: s.color, size: rand(1.1, 1.9),
          twinkle: rand(4, 12), phase: rand(0, 6.283),
        });
      }

      flashes.push({ x: s.x, y: s.y, life: 0, max: 0.34, power: s.power });
    }

    // ─── Confetti ───

    // Cannon: a tight, fast cone from a bottom corner, the way a real
    // confetti cannon fires — not a gentle rain from the ceiling.
    function fireCannon(side) {
      const fromLeft = side < 0;
      const ox = fromLeft ? -w * 0.02 : w * 1.02;
      const oy = h * 1.0;
      const count = Math.min(150, MAX_CONFETTI - confetti.length);
      for (let i = 0; i < count; i++) {
        // Aimed up and inward, with spread.
        const a = (fromLeft ? -Math.PI * 0.34 : -Math.PI * 0.66) + rand(-0.30, 0.30);
        const speed = h * rand(1.25, 2.15);
        addConfetti({
          x: ox + rand(-10, 10),
          y: oy + rand(-10, 10),
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          // Fired paper spins hard, then settles as it slows.
          vrot: rand(-14, 14),
          vflip: rand(6, 15),
        });
      }
    }

    // The lazy drift that keeps going after the cannons: pieces entering
    // from above with almost no horizontal energy.
    function dropConfetti(n) {
      for (let i = 0; i < n; i++) {
        if (confetti.length >= MAX_CONFETTI) return;
        addConfetti({
          x: rand(-0.05, 1.05) * w,
          y: rand(-0.25, -0.02) * h,
          vx: rand(-25, 25),
          vy: rand(20, 90),
          vrot: rand(-3, 3),
          vflip: rand(2.5, 7),
        });
      }
    }

    function addConfetti(p) {
      // Depth: near pieces are bigger, faster and fully opaque; far pieces
      // are small, slow and translucent. Without this a confetti field
      // reads as a flat sheet of stickers.
      const depth = Math.random();
      const scale = 0.55 + depth * 0.95;
      const ribbon = Math.random() < 0.14;
      confetti.push({
        x: p.x, y: p.y,
        vx: p.vx * (0.7 + depth * 0.5),
        vy: p.vy * (0.7 + depth * 0.5),
        w: (ribbon ? rand(3, 5) : rand(7, 12)) * scale,
        h: (ribbon ? rand(26, 46) : rand(9, 16)) * scale,
        rot: rand(0, Math.PI * 2),
        vrot: p.vrot,
        flip: rand(0, Math.PI * 2),
        vflip: p.vflip,
        color: Math.random() < ACCENT_CHANCE ? ACCENT_COLOR : pick(CONFETTI_COLORS),
        alpha: 0.55 + depth * 0.45,
        ribbon,
        // Ribbons catch more air.
        drag: ribbon ? 1.5 : 0.85 + (1 - depth) * 0.9,
        sway: rand(0.6, 1.9),
        swayPhase: rand(0, 6.283),
      });
    }

    // ─── Loop ───

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let last = t0;
    let raf = 0;
    let nextShellAt = t0 + REVEAL.HERO;
    let nextDropAt = t0 + REVEAL.CANNON;
    let cannonsFired = false;
    let running = true;

    function step(now) {
      raf = requestAnimationFrame(step);
      if (!running) { last = now; return; }

      // Clamp dt so a tab-switch or a GC pause doesn't teleport every
      // particle off-screen in one frame.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now - t0;
      if (!w || !h) return;

      // ── Scheduling ──

      // The opening volley is timed to the hero slam, then the sky thins
      // out on a curve and eventually goes quiet for good.
      if (t < FIREWORKS_END_MS && now >= nextShellAt) {
        if (t < REVEAL.CANNON) {
          // The hit: three big shells right on the downbeat.
          launchShell({ power: rand(1.1, 1.35) });
          launchShell({ power: rand(1.0, 1.25) });
          nextShellAt = now + rand(90, 220);
        } else {
          const heavy = t < FIREWORKS_HEAVY_MS;
          if (heavy && Math.random() < 0.45) launchShell({});
          launchShell({});
          // Gap grows from ~0.4s during the volley out to ~3.5s at the end.
          const k = Math.min(1, (t - REVEAL.CANNON) / (FIREWORKS_END_MS - REVEAL.CANNON));
          nextShellAt = now + rand(380, 800) + k * k * 2700;
        }
      }

      if (!cannonsFired && t >= REVEAL.CANNON) {
        cannonsFired = true;
        fireCannon(-1);
        fireCannon(1);
      }

      // Ambient drift after the cannons, tapering off with the fireworks.
      if (t > REVEAL.CANNON && t < FIREWORKS_END_MS && now >= nextDropAt) {
        const k = Math.min(1, t / FIREWORKS_HEAVY_MS);
        dropConfetti(k < 1 ? 3 : 1);
        nextDropAt = now + rand(120, 300) + k * 500;
      }

      // ── Integrate: shells ──
      const gs = gShell();
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i];
        s.vy += gs * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        // Burst at apex.
        if (s.vy >= 0) {
          burst(s);
          shells.splice(i, 1);
        }
      }

      // ── Integrate: sparks ──
      const gp = gSpark();
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.life += dt;
        if (p.life >= p.max) { sparks.splice(i, 1); continue; }
        // Exponential air drag — sparks decelerate hard at first, which is
        // the single biggest cue that they're tiny burning particles.
        const damp = Math.exp(-p.drag * dt);
        p.vx *= damp;
        p.vy *= damp;
        p.vy += gp * p.gmul * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }

      // ── Integrate: confetti ──
      const gc = gConf();
      for (let i = confetti.length - 1; i >= 0; i--) {
        const c = confetti[i];
        const damp = Math.exp(-c.drag * dt);
        c.vx *= damp;
        c.vy *= damp;
        c.vy += gc * dt;
        // Flutter: paper slips sideways as it turns edge-on.
        c.swayPhase += dt * c.sway * 3.2;
        c.x += (c.vx + Math.cos(c.swayPhase) * 34 * c.sway) * dt;
        c.y += c.vy * dt;
        c.rot += c.vrot * dt;
        c.flip += c.vflip * dt;
        // Spin bleeds off with velocity so pieces settle instead of
        // buzzing like propellers all the way down.
        c.vrot *= Math.exp(-0.55 * dt);
        c.vflip *= Math.exp(-0.35 * dt);
        if (c.y > h + 80 || c.x < -140 || c.x > w + 140) confetti.splice(i, 1);
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        flashes[i].life += dt;
        if (flashes[i].life >= flashes[i].max) flashes.splice(i, 1);
      }

      drawBack();
      drawFront();
    }

    function drawBack() {
      // Fade rather than clear: what's left of the previous frame becomes
      // the spark trails. 0.20 ≈ a 5-frame tail at 60fps.
      bctx.globalCompositeOperation = 'destination-out';
      bctx.fillStyle = 'rgba(0,0,0,0.20)';
      bctx.fillRect(0, 0, w, h);

      // Additive from here on — overlapping sparks blow out to white-hot
      // at the core of a burst, exactly like the real thing.
      bctx.globalCompositeOperation = 'lighter';

      // Burst flash: a short warm bloom that lights the sky around it.
      for (let i = 0; i < flashes.length; i++) {
        const f = flashes[i];
        const k = 1 - f.life / f.max;
        const r = Math.min(w, h) * 0.55 * f.power * (0.35 + (1 - k) * 0.9);
        const g = bctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
        g.addColorStop(0, 'rgba(255,240,205,' + (0.34 * k * k).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,220,150,0)');
        bctx.fillStyle = g;
        bctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      }

      // Rising shells — a bright head plus a stubby motion-blur tail.
      for (let i = 0; i < shells.length; i++) {
        const s = shells[i];
        const [r, gg, b] = s.color;
        bctx.strokeStyle = 'rgba(' + r + ',' + gg + ',' + b + ',0.55)';
        bctx.lineWidth = 2.4;
        bctx.lineCap = 'round';
        bctx.beginPath();
        bctx.moveTo(s.x, s.y);
        bctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
        bctx.stroke();
        bctx.fillStyle = 'rgba(255,248,225,0.95)';
        bctx.beginPath();
        bctx.arc(s.x, s.y, 2.2, 0, 6.2832);
        bctx.fill();
      }

      // Sparks. Squared falloff so a burst holds its brightness and then
      // drops away quickly, instead of dimming linearly (which reads as a
      // slow fade rather than a burn-out).
      for (let i = 0; i < sparks.length; i++) {
        const p = sparks[i];
        const k = 1 - p.life / p.max;
        let a = k * k;
        if (p.twinkle) {
          // Glitter: a fast on/off flicker, biased so it's mostly lit.
          a *= 0.45 + 0.55 * Math.max(0, Math.sin(p.life * p.twinkle + p.phase));
        }
        if (a <= 0.01) continue;
        const [r, g, b] = p.color;
        bctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
        bctx.beginPath();
        bctx.arc(p.x, p.y, p.size, 0, 6.2832);
        bctx.fill();
      }

      bctx.globalCompositeOperation = 'source-over';
    }

    function drawFront() {
      fctx.clearRect(0, 0, w, h);
      for (let i = 0; i < confetti.length; i++) {
        const c = confetti[i];
        // cos(flip) squashes the piece toward zero width as it turns
        // edge-on — a cheap, convincing stand-in for 3D rotation.
        const squash = Math.cos(c.flip);
        const aSquash = Math.abs(squash);
        if (aSquash < 0.02) continue;
        fctx.save();
        fctx.translate(c.x, c.y);
        fctx.rotate(c.rot);
        fctx.scale(aSquash, 1);
        // Edge-on pieces catch less light: darken toward the turn.
        fctx.globalAlpha = c.alpha * (0.55 + aSquash * 0.45);
        fctx.fillStyle = c.color;
        if (c.ribbon) {
          // Streamers curl rather than staying rigid.
          fctx.beginPath();
          fctx.moveTo(-c.w / 2, -c.h / 2);
          fctx.quadraticCurveTo(c.w * 1.4, 0, -c.w / 2, c.h / 2);
          fctx.quadraticCurveTo(c.w * 0.5, 0, -c.w / 2, -c.h / 2);
          fctx.fill();
        } else {
          fctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
        }
        fctx.restore();
      }
      fctx.globalAlpha = 1;
    }

    // Reduced-motion: one still frame of settled confetti, no loop.
    function drawStatic() {
      fctx.clearRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        fctx.save();
        fctx.translate(rand(0, w), rand(0, h));
        fctx.rotate(rand(0, 6.2832));
        fctx.globalAlpha = rand(0.35, 0.8);
        fctx.fillStyle = pick(CONFETTI_COLORS);
        fctx.fillRect(-5, -2, 10, 4);
        fctx.restore();
      }
      fctx.globalAlpha = 1;
    }

    // Don't burn frames (or bank up a huge dt) while the TV tab is hidden.
    function onVisibility() {
      running = !document.hidden;
      last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }
    document.addEventListener('visibilitychange', onVisibility);

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={backRef} className="tv-celebration tv-celebration--back" aria-hidden="true" />
      <canvas ref={frontRef} className="tv-celebration tv-celebration--front" aria-hidden="true" />
    </>
  );
}
