import React, { useEffect, useRef, useState } from 'react';
import { pieceById, isPhotoPiece, isAiPiece, pieceUrlWithExpression, expressionForState } from '../lib/pieces';
import * as sfx from '../lib/sfx';

// Painted-board mode: the board image IS the map. Player tokens float along
// a path traced over the artwork. Each tile position is stored as a
// percentage of the image's width/height so the board scales cleanly.
//
// This PATH is traced over the real Central Perk'd board art (board1.jpg):
// 33 waypoints, index 0 = START (the doormat) → 1..31 up the path → 32 = FINISH
// (the couch). Re-trace with /tv?calibrate if the art changes, then ?adjust to
// drag any space that needs nudging. waypointIdx() maps a board position onto
// the nearest waypoint, so the shorter 16-space test board renders on this same
// path — it just doubles pieces up until each space has its own waypoint.
//
// Coordinates are the visual center of each numbered tile (where the wooden
// base disc should land). The CSS anchors the token's bottom-center to this
// point via `transform: translate(-50%, -88%)`, so the figurine rises above
// the disc. If a tile looks misaligned, tweak its row here.

// Captured via WYSIWYG ?calibrate mode with center-anchored piece preview,
// so each coord is the visual CENTER of the piece on its tile.
const PATH = [
  { x:  8.8, y: 26.8 },  //  0  START
  { x: 16.5, y: 10.2 },  //  1
  { x: 22.5, y:  7.4 },  //  2
  { x: 29.5, y:  6.7 },  //  3
  { x: 36.9, y:  7.3 },  //  4
  { x: 44.1, y:  7.8 },  //  5
  { x: 51.6, y:  9.5 },  //  6
  { x:   59, y: 10.2 },  //  7
  { x: 65.8, y: 11.1 },  //  8
  { x: 71.8, y: 12.2 },  //  9
  { x:   78, y: 14.6 },  // 10
  { x: 83.8, y: 20.8 },  // 11
  { x: 85.8, y: 29.9 },  // 12
  { x: 85.2, y: 38.9 },  // 13
  { x: 79.8, y: 47.6 },  // 14
  { x: 69.9, y: 49.4 },  // 15
  { x:   61, y: 48.8 },  // 16
  { x: 53.8, y: 47.4 },  // 17
  { x: 45.1, y: 47.2 },  // 18
  { x: 36.5, y: 45.9 },  // 19
  { x: 28.3, y: 45.9 },  // 20
  { x:   20, y: 48.6 },  // 21
  { x:   13, y: 55.5 },  // 22
  { x: 13.4, y: 68.1 },  // 23
  { x: 18.7, y:   76 },  // 24
  { x: 25.9, y: 78.9 },  // 25
  { x: 33.4, y:   79 },  // 26
  { x: 41.2, y: 78.5 },  // 27
  { x: 50.1, y: 78.1 },  // 28
  { x:   58, y: 78.6 },  // 29
  { x: 64.4, y:   79 },  // 30
  { x: 72.3, y: 81.1 },  // 31
  { x: 86.2, y: 82.6 }   // 32  FINISH
];

// Snap to the nearest PATH waypoint so tokens always land in tile centers.
// For a 32-space game (default) and this 33-entry PATH, position N maps to
// PATH[N] exactly. For the 16-space test board we round to the nearest index.
function waypointIdx(pos, spaces) {
  if (spaces <= 0) return 0;
  const t = Math.max(0, Math.min(1, pos / spaces));
  return Math.round(t * (PATH.length - 1));
}
function positionFor(pos, spaces) {
  return PATH[waypointIdx(pos, spaces)];
}

// Pack N tokens inside a tile so they don't touch. Offsets are in %
// units of board width (x) and board height (y). A token at full size is
// ~3.6% of board width wide and ~5.5% of board height tall, so when more
// than one piece shares a tile we shrink them and space wider than the
// scaled width to leave a small gap.
function packArrangement(n) {
  if (n <= 1) return { scale: 1, offsets: [[0, 0]] };
  // First piece (index 0) stays at the tile center; others fan around it.
  // Pieces are kept large enough to read clearly even when crowded; some
  // overlap with the centered piece is intentional. z-index in the JSX
  // keeps the first piece on top so it stays fully visible.
  if (n === 2) return { scale: 0.9,  offsets: [[0, 0], [3, 0]] };
  if (n === 3) return { scale: 0.85, offsets: [[0, 0], [-3, 0], [3, 0]] };
  if (n === 4) return { scale: 0.8,  offsets: [[0, 0], [-3, 0], [3, 0], [0, -3]] };
  if (n === 5) return { scale: 0.75, offsets: [[0, 0], [-3, 0], [3, 0], [-1.7, -2.7], [1.7, -2.7]] };
  // 6–8 players: two rows, with the BACK row's x-positions staggered between
  // the front-row pieces so every piece has its own horizontal slot and pokes
  // out clearly. Front-row indices come first → they get the higher z-index
  // and sit on top of the back row where they overlap vertically.
  if (n === 6) return { scale: 0.7, offsets: [
    [-4.5, 0.3], [-1.5, 0.3], [1.5, 0.3], [4.5, 0.3],   // front row of 4
    [-3,  -2.7], [3,  -2.7]                              // back row of 2, between front pieces
  ]};
  if (n === 7) return { scale: 0.65, offsets: [
    [-4.5, 0.3], [-1.5, 0.3], [1.5, 0.3], [4.5, 0.3],   // front row of 4
    [-3,  -2.7], [0,  -2.7], [3,  -2.7]                  // back row of 3, between/centered
  ]};
  // n === 8 (room max): 4 front + 4 back, fully staggered.
  return { scale: 0.6, offsets: [
    [-4.5, 0.3], [-1.5, 0.3], [1.5, 0.3], [4.5, 0.3],   // front row of 4
    [-6,  -2.7], [-3, -2.7], [3,  -2.7], [6,  -2.7]      // back row of 4, between/outside
  ]};
}

// URL flags: ?debug overlays current PATH; ?calibrate enters click-to-
// capture mode; ?adjust enters drag-to-position mode for fine-tuning
// the current PATH in place.
function useFlags() {
  if (typeof window === 'undefined') return { debug: false, calibrate: false, adjust: false };
  return {
    debug: window.location.search.includes('debug'),
    calibrate: window.location.search.includes('calibrate'),
    adjust: window.location.search.includes('adjust')
  };
}

// The calibrator asks for one click per board index — START, every numbered
// space, then FINISH — driven by the room's configured board length rather
// than by the current PATH, so re-tracing a NEW board asks for the right
// number of points instead of the old board's.
function calibrateLabels(spaces) {
  const n = Math.max(2, Math.round(spaces) || PATH.length - 1);
  return Array.from({ length: n + 1 }, (_, i) =>
    i === 0 ? 'START' : i === n ? 'FINISH' : String(i));
}

// Click-to-place with WYSIWYG preview: a translucent lantern piece follows
// the cursor using the EXACT same CSS as a real game piece, so what the user
// sees IS where the piece will land. After each click, the placement
// freezes (full opacity) and the prompt advances to the next tile.
const PREVIEW_PIECE_SRC = '/pieces/lantern.png'; // placeholder art

function Calibrator({ spaces }) {
  const LABELS = calibrateLabels(spaces);
  const [coords, setCoords] = useState([]);
  const [cursor, setCursor] = useState(null); // { x, y } in % of frame, or null
  const [done, setDone] = useState(false);

  useEffect(() => {
    function pctOfFrame(e) {
      var frame = document.querySelector('.tv-board-frame');
      if (!frame) return null;
      var rect = frame.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return null;
      return {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100
      };
    }
    function onMove(e) {
      if (done) return;
      setCursor(pctOfFrame(e));
    }
    function onClick(e) {
      if (done) return;
      var pt = pctOfFrame(e);
      if (!pt) return;
      setCoords((prev) => {
        var next = prev.concat([{ x: +pt.x.toFixed(1), y: +pt.y.toFixed(1) }]);
        if (next.length >= LABELS.length) setDone(true);
        return next;
      });
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [done]);

  const nextIdx = coords.length;
  const nextLabel = LABELS[nextIdx];

  const arrayText = coords.map((c, i) => {
    var pad = String(i).padStart(2, ' ');
    var lbl = i === 0 ? 'START' : i === coords.length - 1 ? 'FINISH' : String(i);
    return '  { x: ' + c.x.toString().padStart(4) + ', y: ' + c.y.toString().padStart(4) + ' },  // ' + pad + '  ' + lbl;
  }).join('\n');

  return (
    <div className="tv-calibrator">
      {!done && (
        <div className="tv-calibrator-prompt">
          Click to place <strong>{nextLabel}</strong>
          <span className="counter">{nextIdx + 1} / {LABELS.length}</span>
        </div>
      )}

      {/* Confirmed placements — full-opacity pieces using real .tv-token CSS. */}
      {coords.map((c, i) => (
        <div
          key={'placed-' + i}
          className="tv-token tv-token--placed"
          style={{ left: c.x + '%', top: c.y + '%' }}
        >
          <img src={PREVIEW_PIECE_SRC} alt={'tile ' + i} className="tv-token-img" />
        </div>
      ))}

      {/* Live cursor preview — translucent so the user can see it tracking. */}
      {!done && cursor && (
        <div
          className="tv-token tv-token--preview"
          style={{ left: cursor.x + '%', top: cursor.y + '%' }}
        >
          <img src={PREVIEW_PIECE_SRC} alt="preview" className="tv-token-img" />
        </div>
      )}

      {done && (
        <div className="tv-calibrator-output">
          <div>Done. Copy the array below and paste it back:</div>
          <textarea readOnly value={'const PATH = [\n' + arrayText + '\n];'} />
          <button onClick={() => { setCoords([]); setDone(false); setCursor(null); }}>Redo</button>
        </div>
      )}
    </div>
  );
}

// Drag-to-adjust: renders one draggable piece per PATH waypoint at its current
// coords. The output array updates live as you drag. Designed for fine-tuning
// placements that calibration didn't get quite right.
function Adjuster() {
  const [coords, setCoords] = useState(PATH.map((p) => ({ x: p.x, y: p.y })));
  const [dragging, setDragging] = useState(null); // index, or null

  useEffect(() => {
    if (dragging === null) return;
    function pctOfFrame(e) {
      var frame = document.querySelector('.tv-board-frame');
      if (!frame) return null;
      var rect = frame.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100
      };
    }
    function onMove(e) {
      var pt = pctOfFrame(e);
      if (!pt) return;
      setCoords((prev) => {
        var next = prev.slice();
        next[dragging] = { x: +pt.x.toFixed(1), y: +pt.y.toFixed(1) };
        return next;
      });
    }
    function onUp() { setDragging(null); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const arrayText = coords.map((c, i) => {
    var pad = String(i).padStart(2, ' ');
    var lbl = i === 0 ? 'START' : i === coords.length - 1 ? 'FINISH' : String(i);
    return '  { x: ' + c.x.toString().padStart(4) + ', y: ' + c.y.toString().padStart(4) + ' },  // ' + pad + '  ' + lbl;
  }).join('\n');

  return (
    <div className="tv-adjuster">
      <div className="tv-adjuster-prompt">
        Drag any piece to reposition. Output updates live → copy below when done.
      </div>
      {coords.map((c, i) => (
        <div
          key={'adj-' + i}
          className={'tv-token tv-token--adjust' + (dragging === i ? ' is-dragging' : '')}
          style={{ left: c.x + '%', top: c.y + '%' }}
          onMouseDown={(e) => { e.preventDefault(); setDragging(i); }}
        >
          <img src={PREVIEW_PIECE_SRC} alt={'tile ' + i} className="tv-token-img" />
          <span className="tv-adjuster-label">{i === 0 ? 'S' : i === coords.length - 1 ? 'F' : i}</span>
        </div>
      ))}
      <div className="tv-adjuster-output">
        <textarea readOnly value={'const PATH = [\n' + arrayText + '\n];'} />
      </div>
    </div>
  );
}

export default function Board2D({ players, spaces, slideUsers, results, state }) {
  const { debug, calibrate, adjust } = useFlags();
  const aiExpression = expressionForState(state);

  // Only show pieces for players currently connected. A player who hits the
  // leave button is marked connected=false on the server, so they vanish from
  // the board immediately.
  const activePlayers = players.filter((p) => p.connected);

  // ── Imperative move + sound controller ─────────────────────────────────
  // Tokens render as ONE flat keyed list (a stable DOM node per player for
  // its whole life) and are NEVER positioned by React after first paint.
  // All motion is driven imperatively with the Web Animations API against
  // those stable nodes: one piece glides at a time and its slide sound fires
  // in the SAME synchronous step, so motion and audio cannot drift. WAAPI
  // animations are explicit objects we own — React re-renders, extra
  // snapshots and browser load can't skip, coalesce or desync them. This
  // replaces the prior CSS-transition + React-render-coupled approach whose
  // grouped render remounted tokens on tile change (→ snap / "appears
  // elsewhere") and globally re-packed every tick (→ random jitter).
  const MOVE_STAGGER_MS = 1000;   // == server SLIDE_STAGGER_MS
  const SLIDE_MS = 1700;          // == server SLIDE_MS
  const SLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const SLIDE_ARC_MS = 2600;     // == tv-token-slide-cross duration
  // Arrow-tile bonus is a TWO-LEG move: walk onto the arrow (SLIDE_MS), STOP and
  // announce (ADV_PAUSE_MS), then hop forward the bonus (ADV_HOP_MS). The server
  // budgets the SCORING phase from the SAME numbers (ADV_PAUSE_MS + ADV_HOP_MS,
  // see ADVANCE_EXTRA_MS in game.js) — keep them in sync or the last hop gets
  // cut off when the round advances.
  const ADV_PAUSE_MS = 1000;
  const ADV_HOP_MS = 1300;

  const orderIndex = {};
  activePlayers.forEach((p, i) => { orderIndex[p.id] = i; });

  const tokenElsRef = useRef(new Map()); // playerId -> DOM node (stable)
  const shownRef = useRef({});           // playerId -> displayed tile pos
  const targetSigRef = useRef('');       // dedupe signature
  const genRef = useRef(0);              // supersede counter
  const slideStartsRef = useRef({});    // playerId -> PATH coord to arc FROM
  const slideActiveRef = useRef(new Set()); // ids mid bridge-arc
  const pendingTimerRef = useRef(null);  // the single chained stagger timer
  const auxTimersRef = useRef([]);       // bridge class-removal timers
  const popsRef = useRef({});            // playerId -> { cls, icon, text } landing flair
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => n + 1);

  // The controller reads results via a ref so a fresh snapshot updates the
  // landing blurbs WITHOUT re-triggering the move effect (which keys only off
  // the target-tile set). lastResults arrives in the same snapshot as the
  // positions, so it's always current by the time a piece lands.
  const resultsRef = useRef(results);
  resultsRef.current = results;

  // Pure: {playerId: tilePos} -> {playerId: {x,y,scale,z}} via the shared
  // PATH / packArrangement. Each tile's members are slot-ordered by join
  // order so a resting piece keeps a STABLE slot across recomputes (this is
  // what kills the old per-tick repack jitter).
  function computeLayout(tiles) {
    const groups = {};
    for (const id in tiles) (groups[tiles[id]] = groups[tiles[id]] || []).push(id);
    const out = {};
    for (const t in groups) {
      const ids = groups[t].sort((a, b) => (orderIndex[a] || 0) - (orderIndex[b] || 0));
      const pt = positionFor(parseInt(t, 10), spaces);
      const { scale, offsets } = packArrangement(ids.length);
      ids.forEach((id, i) => {
        const [dx, dy] = offsets[i];
        out[id] = { x: pt.x + dx, y: pt.y + dy, scale, z: 10 - i };
      });
    }
    return out;
  }

  // First sight of any player: show them where they already are (no slide).
  for (const p of activePlayers) {
    if (shownRef.current[p.id] === undefined) {
      shownRef.current[p.id] = Math.min(p.position, spaces);
    }
  }

  // Authoritative REST layout for THIS render. While a piece is gliding its
  // WAAPI animation (fill:forwards) visually overrides this, so a React
  // re-render writing the rest coord underneath never disturbs the glide.
  const shownTilesRender = {};
  for (const p of activePlayers) shownTilesRender[p.id] = shownRef.current[p.id];
  const layout = computeLayout(shownTilesRender);

  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function shownTilesNow() {
      const t = {};
      for (const p of activePlayers) {
        const v = shownRef.current[p.id];
        if (v !== undefined) t[p.id] = v;
      }
      return t;
    }

    const targets = {};
    for (const p of activePlayers) targets[p.id] = Math.min(p.position, spaces);
    // Only react when the target SET genuinely changes. Redundant snapshots
    // (pause/resume/heartbeat) and our own tick re-renders share the same
    // signature and are ignored — they can never restart an in-flight run.
    const sig = Object.keys(targets).sort()
      .map((id) => id + ':' + waypointIdx(targets[id], spaces)).join('|');
    if (sig === targetSigRef.current) return;
    targetSigRef.current = sig;

    // Supersede any run still in flight: stop the chain + bridge timers,
    // drop bridge state, cancel every live animation, and settle each token
    // on its CURRENT displayed tile (a real tile, never fractional limbo).
    const gen = ++genRef.current;
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    auxTimersRef.current.forEach((t) => clearTimeout(t));
    auxTimersRef.current = [];
    slideActiveRef.current.clear();
    tokenElsRef.current.forEach((el) => {
      if (el.getAnimations) el.getAnimations().forEach((a) => a.cancel());
    });
    const settle = computeLayout(shownTilesNow());
    tokenElsRef.current.forEach((el, id) => {
      const c = settle[id];
      if (c) { el.style.left = c.x + '%'; el.style.top = c.y + '%'; }
    });

    // Classify against the displayed tiles.
    const movers = [];
    for (const p of activePlayers) {
      const tgt = targets[p.id];
      const shown = shownRef.current[p.id];
      if (shown === undefined) { shownRef.current[p.id] = tgt; continue; }
      if (waypointIdx(shown, spaces) === waypointIdx(tgt, spaces)) {
        if (shown !== tgt) shownRef.current[p.id] = tgt; // same square, silent
      } else {
        const usedSlide = !!(slideUsers && slideUsers[p.id]);
        if (usedSlide) slideStartsRef.current[p.id] = PATH[waypointIdx(shown, spaces)];
        movers.push({ id: p.id, tgt, order: orderIndex[p.id] || 0, usedSlide });
      }
    }
    rerender(); // apply any silent same-square updates / settle
    if (!movers.length) return;
    movers.sort((a, b) => a.order - b.order);

    // Glide one element from `from` to `c` (or jump under reduced motion).
    function applyCoord(id, c, from) {
      const el = tokenElsRef.current.get(id);
      if (!el || !c) return;
      if (from && !reduce && el.animate) {
        const anim = el.animate(
          [{ left: from.x + '%', top: from.y + '%' },
           { left: c.x + '%',    top: c.y + '%' }],
          { duration: SLIDE_MS, easing: SLIDE_EASING, fill: 'forwards' }
        );
        anim.onfinish = () => {
          if (gen !== genRef.current) return;
          try { anim.commitStyles(); } catch (e) {}
          el.style.left = c.x + '%';
          el.style.top = c.y + '%';
          try { anim.cancel(); } catch (e) {}
        };
      } else {
        el.style.left = c.x + '%';
        el.style.top = c.y + '%';
      }
    }

    // Keyframes that FOLLOW THE BOARD ROUTE: leave the start packed slot,
    // pass through every PATH tile-centre between the two tiles, then settle
    // into the final packed slot — so a piece walks the spaces instead of
    // cutting a straight diagonal across the artwork.
    function pathFrames(fromC, toC, startIdx, endIdx) {
      const frames = [{ left: fromC.x + '%', top: fromC.y + '%' }];
      const step = endIdx > startIdx ? 1 : -1;
      for (let k = startIdx + step; k !== endIdx; k += step) {
        const pt = PATH[k];
        if (pt) frames.push({ left: pt.x + '%', top: pt.y + '%' });
      }
      frames.push({ left: toC.x + '%', top: toC.y + '%' });
      return frames;
    }

    // Multi-keyframe variant of applyCoord (a whole path). One animation per
    // piece per step; the slide sound is fired by the caller in the same
    // tick so motion + audio stay locked together.
    function glide(id, frames, finalC) {
      const el = tokenElsRef.current.get(id);
      if (!el || !finalC) return;
      if (frames && !reduce && el.animate) {
        const anim = el.animate(frames,
          { duration: SLIDE_MS, easing: SLIDE_EASING, fill: 'forwards' });
        anim.onfinish = () => {
          if (gen !== genRef.current) return;
          try { anim.commitStyles(); } catch (e) {}
          el.style.left = finalC.x + '%';
          el.style.top = finalC.y + '%';
          try { anim.cancel(); } catch (e) {}
        };
      } else {
        el.style.left = finalC.x + '%';
        el.style.top = finalC.y + '%';
      }
    }

    // Slide/shortcut motion: a lifted hop from `fromC` to `toC`. Unlike glide()
    // it does NOT walk the intervening squares — a shortcut is precisely the
    // act of skipping them — so it's a single soaring arc instead. The lift is
    // proportional to the distance travelled, so a two-space nudge doesn't
    // launch the piece into the sky.
    function arc(id, fromC, toC, dur = SLIDE_ARC_MS) {
      const el = tokenElsRef.current.get(id);
      if (!el || !fromC || !toC) return;
      const dist = Math.hypot(toC.x - fromC.x, toC.y - fromC.y);
      const lift = Math.min(14, Math.max(4, dist * 0.35));
      const midX = (fromC.x + toC.x) / 2;
      const midY = (fromC.y + toC.y) / 2 - lift;
      const frames = [
        { left: fromC.x + '%', top: fromC.y + '%', offset: 0 },
        { left: midX + '%', top: midY + '%', offset: 0.5 },
        { left: toC.x + '%', top: toC.y + '%', offset: 1 }
      ];
      if (!el.animate) {
        el.style.left = toC.x + '%';
        el.style.top = toC.y + '%';
        return;
      }
      const anim = el.animate(frames, {
        duration: dur,
        easing: 'cubic-bezier(0.4, 0, 0.4, 1)',
        fill: 'forwards'
      });
      anim.onfinish = () => {
        if (gen !== genRef.current) return;
        try { anim.commitStyles(); } catch (e) {}
        el.style.left = toC.x + '%';
        el.style.top = toC.y + '%';
        try { anim.cancel(); } catch (e) {}
      };
    }

    // Landing flair: after `delay`, show a blurb above the piece explaining
    // the special tile it landed on (and optionally play a cue), then clear it
    // after POP_HOLD_MS. Timers are tracked so a superseding run cancels them.
    const POP_HOLD_MS = 2400;
    function firePop(id, data, delay, sound) {
      const t1 = setTimeout(() => {
        if (gen !== genRef.current) return;
        popsRef.current[id] = data;
        if (sound) sound();
        rerender();
        const t2 = setTimeout(() => {
          if (gen !== genRef.current) return;
          delete popsRef.current[id];
          rerender();
        }, POP_HOLD_MS);
        auxTimersRef.current.push(t2);
      }, delay);
      auxTimersRef.current.push(t1);
    }

    // Scoot: any OTHER piece whose packed coord changed because m joined its
    // destination tile or vacated a shared origin tile moves now, same
    // duration, NO sound — choreographed, never random. A piece mid-hop
    // (slideActive) is left alone.
    function scootOthers(fromL, toL, excludeId) {
      for (const id in toL) {
        if (id === excludeId || slideActiveRef.current.has(id)) continue;
        const b = fromL[id], a = toL[id];
        if (b && a && (b.x !== a.x || b.y !== a.y)) applyCoord(id, a, b);
      }
    }

    function runStep(i) {
      if (gen !== genRef.current) return;
      const m = movers[i];
      const startPos = shownRef.current[m.id];  // tile m is leaving FROM
      const before = computeLayout(shownTilesNow());

      const res = resultsRef.current && resultsRef.current[m.id];
      const advN = res && res.advanced ? res.advanced : 0;
      const advText = advN === 1 ? 'Skip a space!' : advN ? 'Skip ' + advN + ' spaces!' : 'Bonus!';

      if (m.usedSlide && !reduce) {
        // TWO-LEG arrow bonus, so the player actually FEELS the reward:
        //   1. WALK the earned spaces onto the arrow tile and stop there.
        //   2. STOP + announce — the "Skip a space!" blurb and cue fire as the
        //      walk finishes and the piece sits on the arrow.
        //   3. HOP forward the bonus space(s) after a beat.
        // slideUsers[id].from is the arrow tile (set server-side); m.tgt is the
        // final tile after the hop.
        const sl = slideUsers && slideUsers[m.id];
        const arrowIdx = sl && Number.isInteger(sl.from) ? sl.from : waypointIdx(m.tgt, spaces);

        // The REST position stays on the arrow through the walk + pause, so any
        // re-render (the flair pop, a later mover, React) writes the arrow coord
        // underneath the animation instead of snapping the piece to its final
        // tile early. It only advances to m.tgt when the hop begins.
        shownRef.current[m.id] = Math.min(arrowIdx, spaces);
        const mid = computeLayout(shownTilesNow());
        const arrowC = mid[m.id] || positionFor(arrowIdx, spaces);

        // Leg 1 — walk onto the arrow; anyone leaving a shared origin repacks.
        glide(m.id,
          pathFrames(before[m.id], arrowC, waypointIdx(startPos, spaces), arrowIdx),
          arrowC);
        sfx.slide();
        scootOthers(before, mid, m.id);

        // Stop + announce as the walk lands.
        firePop(m.id, { cls: 'is-advance', icon: '', text: advText }, SLIDE_MS, sfx.advance);

        // Leg 2 — after the pause, advance the rest position to the final tile
        // and hop there. tv-token--bridge floats it above the pack for the hop.
        slideActiveRef.current.add(m.id);
        const hop = setTimeout(() => {
          if (gen !== genRef.current) return;
          shownRef.current[m.id] = m.tgt;
          const after = computeLayout(shownTilesNow());
          arc(m.id, arrowC, after[m.id], ADV_HOP_MS);
          scootOthers(mid, after, m.id);
          rerender();
          const rm = setTimeout(() => {
            if (gen !== genRef.current) return;
            slideActiveRef.current.delete(m.id);
            rerender();
          }, ADV_HOP_MS);
          auxTimersRef.current.push(rm);
        }, SLIDE_MS + ADV_PAUSE_MS);
        auxTimersRef.current.push(hop);
      } else {
        // Single-leg move: commit the rest position to the final tile now.
        shownRef.current[m.id] = m.tgt;
        const after = computeLayout(shownTilesNow());
        if (m.usedSlide) {
          // Reduced motion: jump straight to final, still announce.
          applyCoord(m.id, after[m.id], null);
          firePop(m.id, { cls: 'is-advance', icon: '', text: advText }, 0, sfx.advance);
        } else {
          // Normal walk from the old tile to the new one.
          glide(m.id,
            pathFrames(before[m.id], after[m.id],
              waypointIdx(startPos, spaces), waypointIdx(m.tgt, spaces)),
            after[m.id]);
          sfx.slide();
          // A coffee cup doesn't move the piece further — it just walks onto the
          // tile — so its chime + blurb fire on arrival at the end of the walk.
          if (res && res.landedBonus) {
            firePop(m.id,
              { cls: 'is-bonus', icon: '☕', text: 'Coffee break — next answer counts double!' },
              SLIDE_MS, sfx.bonus);
          }
        }
        scootOthers(before, after, m.id);
      }

      rerender(); // commit rest coords / scale / z for everyone
      // An arrow mover holds the spotlight through its whole walk→pause→hop so
      // the bonus reads clearly; the next piece waits for the full sequence.
      const nextDelay = (m.usedSlide && !reduce)
        ? (SLIDE_MS + ADV_PAUSE_MS + ADV_HOP_MS)
        : MOVE_STAGGER_MS;
      if (i + 1 < movers.length) {
        pendingTimerRef.current = setTimeout(() => runStep(i + 1), nextDelay);
      }
    }

    pendingTimerRef.current = setTimeout(() => runStep(0), 0);
  }, [activePlayers, spaces, slideUsers]);

  // Drop bridge-start coords once the server clears that player's crossing.
  for (const id of Object.keys(slideStartsRef.current)) {
    if (!slideUsers || !slideUsers[id]) delete slideStartsRef.current[id];
  }

  // Never let a pending release / bridge timer fire into a torn-down board.
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    auxTimersRef.current.forEach((t) => clearTimeout(t));
    auxTimersRef.current = [];
    tokenElsRef.current.forEach((el) => {
      if (el.getAnimations) el.getAnimations().forEach((a) => a.cancel());
    });
  }, []);

  return (
    <div className="tv-board-tokens">
      {adjust && <Adjuster />}
      {calibrate && !adjust && <Calibrator spaces={spaces} />}
      {debug && !calibrate && !adjust && PATH.map((pt, i) => (
        <div
          key={'dbg-' + i}
          className="tv-debug-dot"
          style={{ left: pt.x + '%', top: pt.y + '%' }}
        >
          {i === 0 ? 'S' : i === PATH.length - 1 ? 'F' : i}
        </div>
      ))}
      {/* ONE flat keyed list — a stable DOM node per player for its whole
          life. A piece changing tiles never moves between keyed sibling
          arrays, so React can't remount it (the old snap / "appears
          elsewhere" bug is now structurally impossible). Position/scale/z
          come from `layout` (rest state); the controller's WAAPI animation
          visually overrides left/top while a piece glides. */}
      {activePlayers.map((p) => {
        const piece = pieceById(p.piece);
        const c = layout[p.id] || { x: 0, y: 0, scale: 1, z: 10 };
        const sliding = slideActiveRef.current.has(p.id);
        const bridgeStart = sliding ? slideStartsRef.current[p.id] : null;
        const pop = popsRef.current[p.id];
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) tokenElsRef.current.set(p.id, el);
              else tokenElsRef.current.delete(p.id);
            }}
            className={'tv-token' + (sliding ? ' tv-token--bridge' : '')}
            style={{
              left: c.x + '%',
              top: c.y + '%',
              '--token-scale': c.scale,
              // CSS vars consumed by tv-token-bridge-cross keyframes so the
              // arc starts at the piece's previous board coord.
              ...(bridgeStart && {
                '--bridge-from-x': bridgeStart.x + '%',
                '--bridge-from-y': bridgeStart.y + '%'
              }),
              // The crossing piece floats above the others during its arc;
              // otherwise the first piece in a cluster stays on top.
              zIndex: sliding ? 30 : c.z
            }}
            title={p.name}
          >
            {isPhotoPiece(p.piece)
              ? <img src={p.piece} alt={p.name} className="tv-token-img tv-token-img--photo" />
              : isAiPiece(p.piece)
                ? <img
                    src={pieceUrlWithExpression(p.piece, aiExpression)}
                    alt={p.name}
                    className="tv-token-img"
                    onError={(e) => { if (e.target.src !== p.piece) e.target.src = p.piece; }}
                  />
                : (piece && piece.image
                    ? <img src={piece.image} alt={p.name} className="tv-token-img" />
                    : <span className="tv-token-emoji">{piece ? piece.emoji : '✦'}</span>)}
            {pop && (
              // For pieces near the top of the board the pop would rise off the
              // top edge, so flip it to drop BELOW the piece instead. Keeps every
              // notification on the board.
              <div
                className={'tv-flair-pop ' + pop.cls + (c.y < 26 ? ' tv-flair-pop--below' : '')}
                key={'pop-' + p.id + '-' + pop.text}
              >
                {pop.icon && <span className="tv-flair-pop-icon" aria-hidden="true">{pop.icon}</span>}
                <span className="tv-flair-pop-text">{pop.text}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
