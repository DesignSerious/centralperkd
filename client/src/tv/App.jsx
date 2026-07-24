import React, { useEffect, useRef, useState } from 'react';
import { getSocket, sendAction } from '../lib/socket';
import Fireflies from './Fireflies';
import BoardAmbience from './BoardAmbience';
import Board2D from './Board2D';
import Celebration from './Celebration';
import PieceVisual from '../lib/PieceVisual';
import RulesOverlay from '../lib/RulesOverlay';
import PauseOverlay from '../lib/PauseOverlay';
import { MusicProvider } from '../lib/MusicContext';
import MusicControls from '../lib/MusicControls';
import FullscreenToggle from '../lib/FullscreenToggle';
import AutoFit from '../lib/AutoFit';
import * as sfx from '../lib/sfx';
import { preloadAiPiece } from '../lib/pieces';

// The TV view: the board image is the whole background, player pieces walk
// the tile path over it, and every phase's wording sits in the overlay below.
// The TV is a pure renderer — it never decides a transition, it just draws
// whatever snapshot the server last pushed.

// localStorage key for this TV's chosen music vibe (genre). Stored so the
// pick survives reloads; cleared to fall back to the operator default.
const VIBE_KEY = 'cperkd_music_vibe';

// Synthetic "play everything" vibe id. Not a stored vibe — selecting it
// interleaves one song from each genre playlist, round-robin.
const ALL_VIBES_ID = '__all__';

// Plays the moment the gameboard (TV) page loads: the Friends outro, dropped in
// client/public/audio. Passed to MusicProvider as the LEAD track, so it's heard
// first and then the normal playlist rotation continues after it. Spaces
// %20-encoded so the <audio src> is a valid URL.
const GAMEBOARD_LEAD_TRACK = '/audio/Friends%20outtro.mp3';


// ?dev in the TV URL reveals the bot-simulation button in the lobby.
function isDev() {
  return typeof window !== 'undefined' && window.location.search.includes('dev');
}

// ?calibrate / ?adjust are board-tracing modes. Every phase overlay is hidden
// while they're on — otherwise the lobby panel covers the squares you're
// trying to click.
function isTracing() {
  if (typeof window === 'undefined') return false;
  const q = window.location.search;
  return q.includes('calibrate') || q.includes('adjust');
}

function interleaveVibes(vibesWithTracks) {
  const lists = vibesWithTracks.map((v) => v.tracks);
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const t = list[i];
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

export default function App() {
  const [snap, setSnap] = useState(null);
  const [code, setCode] = useState(null);
  // Music "vibes" fetched from /api/playlist. `pl` stays null until resolved
  // so we hold render until MusicProvider can mount with the right rotation;
  // a 2s timeout guards against a flaky network never letting the TV load.
  const [pl, setPl] = useState(null);
  const [vibeId, setVibeId] = useState(() => {
    try { return localStorage.getItem(VIBE_KEY) || null; } catch (e) { return null; }
  });
  const socketRef = useRef(null);

  useEffect(() => {
    let done = false;
    function resolve(p) { if (!done) { done = true; setPl(p); } }
    fetch('/api/playlist').then((r) => r.json()).then((d) => {
      const volumes = (d && d.volumes && typeof d.volumes === 'object') ? d.volumes : {};
      if (d && Array.isArray(d.vibes) && d.vibes.length) resolve({ vibes: d.vibes, activeVibeId: d.activeVibeId, volumes });
      else resolve({ vibes: [], activeVibeId: null, volumes });
    }).catch(() => resolve({ vibes: [], activeVibeId: null, volumes: {} }));
    const timeoutId = setTimeout(() => resolve({ vibes: [], activeVibeId: null, volumes: {} }), 2000);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    try {
      if (vibeId) localStorage.setItem(VIBE_KEY, vibeId);
      else localStorage.removeItem(VIBE_KEY);
    } catch (e) {}
  }, [vibeId]);

  useEffect(() => {
    const s = getSocket();
    socketRef.current = s;
    const onState = (d) => setSnap(d);
    s.on('state', onState);

    // The room code lives in the URL hash so a TV refresh reattaches to the
    // same room instead of orphaning everyone's phones on a dead code.
    const hash = window.location.hash.replace('#', '').toUpperCase();
    function createNew() {
      s.emit('tv:create', (res) => {
        if (res && res.ok) {
          setCode(res.code);
          window.location.hash = res.code;
        }
      });
    }
    function bootstrap() {
      if (hash && /^[A-Z]{4}$/.test(hash)) {
        s.emit('tv:attach', { code: hash }, (res) => {
          if (res && res.ok) setCode(res.code); else createNew();
        });
      } else {
        createNew();
      }
    }
    if (s.connected) bootstrap();
    s.on('connect', bootstrap);
    return () => { s.off('state', onState); s.off('connect', bootstrap); };
  }, []);

  useEffect(() => {
    if (!snap || !snap.players) return;
    snap.players.forEach((p) => preloadAiPiece(p && p.piece));
  }, [snap && snap.players && snap.players.map((p) => p && p.piece).join('|')]);

  if (!pl) return null;

  const vibes = pl.vibes || [];
  const nonEmpty = vibes.filter((v) => v.tracks && v.tracks.length);
  const allowAll = nonEmpty.length >= 2;
  const has = (id) => (id === ALL_VIBES_ID ? allowAll : vibes.some((v) => v.id === id));
  const activeVibeId =
    (vibeId && has(vibeId) && vibeId) ||
    (has(pl.activeVibeId) && pl.activeVibeId) ||
    (nonEmpty[0] && nonEmpty[0].id) ||
    (vibes[0] && vibes[0].id) ||
    null;
  let trackList;
  let hasTracks;
  if (activeVibeId === ALL_VIBES_ID) {
    const mixed = interleaveVibes(nonEmpty);
    hasTracks = mixed.length > 0;
    trackList = hasTracks ? mixed.map((t) => '/audio/' + t) : [];
  } else {
    const selVibe = vibes.find((v) => v.id === activeVibeId);
    hasTracks = !!(selVibe && selVibe.tracks && selVibe.tracks.length);
    trackList = hasTracks ? selVibe.tracks.map((t) => '/audio/' + t) : [];
  }
  const music = { vibes, vibeId: activeVibeId, allowAll, onPickVibe: setVibeId };
  const inGame = !!(snap && snap.state && snap.state !== 'LOBBY' && snap.state !== 'GAME_OVER');

  return (
    <MusicProvider
      buildRotation={() => buildRotation(trackList)}
      rotationKey={hasTracks ? activeVibeId : '__default'}
      storageKeyOn="cperkd_music_on"
      storageKeyVolume="cperkd_music_volume"
      leadTrackUrl={GAMEBOARD_LEAD_TRACK}
      trackVolumes={pl.volumes || {}}
    >
    <div className="tv-shell">
      <div className="tv-board-frame">
        {/* The Central Perk'd board. Board2D's PATH is traced over this exact
            image — re-trace with /tv?calibrate if the art changes. */}
        <img className="tv-board-bg" src="/board1.jpg" alt="Central Perk'd board" draggable={false} />
        {/* Logo is overlaid (not baked into the board art) so real steam can
            rise from the two mugs. central-perkd-logo-no-steam.png is the logo
            with its painted steam removed; the wisps below animate over each
            mug opening. Sits above the board, below pieces + phase overlays.
            Only shown once the game has started — hidden during the LOBBY /
            setup ("instructions") screen so it doesn't clutter the code panel. */}
        {snap && code && snap.state !== 'LOBBY' && (
          <div className="tv-board-logo-wrap" aria-hidden="true">
            <img className="tv-board-logo" src="/central-perkd-logo-no-steam.png" alt="" draggable={false} />
            <div className="tv-steam tv-steam--left"><i></i><i></i><i></i></div>
            <div className="tv-steam tv-steam--right"><i></i><i></i><i></i></div>
          </div>
        )}
        <BoardAmbience />
        <Fireflies />
        {snap && code && (
          <Board2D
            players={snap.players}
            spaces={snap.settings.boardSpaces}
            slideUsers={snap.lastSlides}
            results={snap.lastResults}
            state={snap.state}
          />
        )}
        <ExitToLobbyButton hasGameInProgress={inGame} />
        <RulesButton snap={snap} />
        {inGame && !snap.paused && (
          <button
            className="tv-pause-btn"
            aria-label="Pause game"
            title="Pause game"
            onClick={() => { sfx.pause(); sendAction('pauseGame'); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="7" y="5" width="3" height="14" />
              <rect x="14" y="5" width="3" height="14" />
            </svg>
          </button>
        )}
        {snap && snap.paused && <PauseOverlay />}

        {isTracing() ? null : snap && code && snap.state === 'GAME_OVER' ? (
          <div className="tv-overlay-center">
            <AutoFit>
              <div className="phase-fade" key={snap.state}>
                <PhaseStage snap={snap} music={music} />
              </div>
            </AutoFit>
          </div>
        ) : snap && code && snap.state === 'SCORING' ? (
          // The results card owns its own entrance and its centered→gone
          // motion as the pieces start walking, so the generic wrapper fade
          // is skipped here (it would double up and add dead air).
          <div className="tv-overlay-scoring">
            <div className="phase-fade phase-fade--instant" key={snap.state}>
              <PhaseStage snap={snap} music={music} />
            </div>
          </div>
        ) : snap && code && snap.state === 'LOBBY' ? (
          // Auto-scaled so the room code and every setting ALWAYS fit the TV
          // without scrolling, no matter the screen size or player count.
          <AutoFit className="tv-lobby-fit">
            <Lobby snap={snap} music={music} />
          </AutoFit>
        ) : (
          <div className="tv-overlay-bottom">
            <div className="phase-fade" key={snap ? snap.state + ':' + snap.round : 'boot'}>
              {snap && code ? <PhaseStage snap={snap} music={music} /> : <BootingStage />}
            </div>
          </div>
        )}

        {snap && code && snap.state === 'GAME_OVER' && <Celebration />}
      </div>

      <MusicControls
        controlClass="tv-audio-control"
        buttonClass="tv-audio-toggle"
        sliderClass="tv-audio-slider"
        sfxSliderClass="tv-audio-slider"
        sliderGroupClass="tv-audio-sliders"
        trackNavClass="tv-audio-track-nav"
        vibeNavClass="tv-audio-vibe-nav"
        vibeNav={music}
        spectrumClass="tv-audio-spectrum"
      />
      <div className="tv-copyright">Central Perk'd © 2026 Totes Wild Entertainment Network</div>
      <FullscreenToggle />
    </div>
    </MusicProvider>
  );
}

// No music ships with the scaffold — drop mp3s into client/public/audio/ and
// sort them into vibes at /playlist. Until then the rotation is empty and the
// player simply stays silent.
function buildRotation(tracks) {
  const out = (tracks || []).slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function ExitToLobbyButton({ hasGameInProgress }) {
  const [confirming, setConfirming] = useState(false);
  function onConfirm() {
    // Tear the room down first so phone players are bounced cleanly too.
    if (hasGameInProgress) sendAction('abortToLobby');
    window.location.href = '/?fromGame=1';
  }
  return (
    <>
      <button className="tv-abort-btn" aria-label="Exit to lobby" title="Exit to lobby" onClick={() => setConfirming(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4 H18 a2 2 0 0 1 2 2 v12 a2 2 0 0 1 -2 2 h-4" />
          <path d="M10 8 l-4 4 4 4" />
          <path d="M6 12 H14" />
        </svg>
      </button>
      {confirming && (
        <div className="lp-modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="lp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="lp-modal-title">Exit to the lobby?</div>
            <div className="lp-modal-body">
              {hasGameInProgress
                ? 'This ends the game in progress for everyone in the room.'
                : 'You’ll go back to the start screen.'}
            </div>
            <div className="lp-modal-actions">
              <button type="button" className="lp-btn lp-btn--ghost" onClick={() => setConfirming(false)}>Stay</button>
              <button type="button" className="lp-btn" onClick={onConfirm}>Exit</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RulesButton({ snap }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button className="tv-rules-btn" aria-label="How to play" title="How to play" onClick={() => setShow(true)}>?</button>
      {show && <RulesOverlay snap={snap} onClose={() => setShow(false)} />}
    </>
  );
}

function BootingStage() {
  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-h1 lp-pulse">Warming up the espresso machine…</div>
    </div>
  );
}

function PhaseStage({ snap, music }) {
  const s = snap.state;
  if (s === 'LOBBY') return <Lobby snap={snap} music={music} />;
  if (s === 'ROUND_INTRO') return <RoundIntroScreen snap={snap} />;
  if (s === 'ANSWERING') return <AnsweringScreen snap={snap} />;
  if (s === 'BLUFFING') return <BluffingScreen snap={snap} />;
  if (s === 'VOTING') return <VotingScreen snap={snap} />;
  if (s === 'REVEAL') return <RevealScreen snap={snap} />;
  if (s === 'REVIEW') return <ReviewStage snap={snap} />;
  if (s === 'SCORING') return <MovementScreen snap={snap} />;
  if (s === 'GAME_OVER') return <GameOverScreen snap={snap} />;
  return null;
}

// ─── LOBBY ───
function Lobby({ snap, music }) {
  const st = snap.settings || {};
  const cats = snap.allCategories || [];
  const on = st.categories && st.categories.length ? st.categories : cats;
  const botCount = snap.players.filter((p) => p.isBot).length;
  const canAddBot = snap.players.length < 8 && botCount < 4;

  const humanCount = snap.players.filter((p) => !p.isBot).length;
  const prevHumansRef = useRef(humanCount);
  useEffect(() => {
    if (humanCount > prevHumansRef.current) sfx.enteredRoom();
    prevHumansRef.current = humanCount;
  }, [humanCount]);

  function set(patch) { sendAction('updateSettings', patch); }
  function toggleCategory(c) {
    const next = on.includes(c) ? on.filter((x) => x !== c) : on.concat(c);
    // The server refuses a set too small to fill a board — the toggle just
    // bounces back rather than breaking anything.
    set({ categories: next });
  }

  return (
    <div className="tv-lobby-wrap">
      <div className="tv-stage tv-stage--lobby">
        <div className="tv-lobby-join">
          <div className="tv-join-cta">
            <span className="url">{window.location.host + '/join'}</span>
            <span className="arrow">→</span>
            <span className="code">{snap.code}</span>
          </div>
        </div>

        <Picker
          label="Board length"
          options={[{ v: 16, label: 'Short (16)' }, { v: 32, label: 'Standard (32)' }, { v: 48, label: 'Long (48)' }]}
          value={st.boardSpaces}
          onPick={(v) => set({ boardSpaces: v })}
          note="The painted board is 32 moves (doormat to couch). Short and long reuse the same path, spaced out."
        />
        <Picker
          label="Answer time"
          options={[20, 25, 40].map((v) => ({ v, label: v + 's' }))}
          value={st.answerSeconds}
          onPick={(v) => set({ answerSeconds: v })}
        />
        <Picker
          label="Bluff time"
          options={[15, 20, 30].map((v) => ({ v, label: v + 's' }))}
          value={st.bluffSeconds}
          onPick={(v) => set({ bluffSeconds: v })}
        />
        <Picker
          label="Vote time"
          options={[20, 25, 40].map((v) => ({ v, label: v + 's' }))}
          value={st.voteSeconds}
          onPick={(v) => set({ voteSeconds: v })}
        />

        <div className="tv-series-picker">
          <div className="tv-series-label">Categories</div>
          <div className="tv-series-options">
            {cats.map((c) => (
              <button
                key={c}
                className={'lp-btn lp-btn--ghost' + (on.includes(c) ? ' tv-series-selected' : '')}
                onClick={() => toggleCategory(c)}
              >{c}</button>
            ))}
          </div>
        </div>

        <div className="tv-series-picker">
          <div className="tv-series-label">Spaces per…</div>
          <div className="tv-series-options">
            <Stepper label="knowing it" value={st.pointsCorrectAnswer} onSet={(v) => set({ pointsCorrectAnswer: v })} />
            <Stepper label="each vote you pull" value={st.pointsPerVote} onSet={(v) => set({ pointsPerVote: v })} />
            <Stepper label="finding the truth" value={st.pointsFoundTruth} onSet={(v) => set({ pointsFoundTruth: v })} />
            <Stepper label="☕ tile multiplier" value={st.bonusTileMultiplier} onSet={(v) => set({ bonusTileMultiplier: v })} min={1} />
          </div>
        </div>

        <Picker
          label="Final round to clinch"
          options={[{ v: false, label: 'Off' }, { v: true, label: 'On' }]}
          value={!!st.finalRoundToClinch}
          onPick={(v) => set({ finalRoundToClinch: v })}
          note={st.finalRoundToClinch
            ? 'Reaching FINISH only wins if you scored that round.'
            : 'First piece to reach FINISH wins outright.'}
        />
        <Picker
          label="Answer reviews"
          options={[{ v: true, label: 'On' }, { v: false, label: 'Off' }]}
          value={st.allowReviews !== false}
          onPick={(v) => set({ allowReviews: v })}
          note={st.allowReviews !== false
            ? 'A player judged wrong can dispute; the other players vote to overturn it.'
            : 'The AI ruling is final — no disputes.'}
        />
        <Picker
          label="Unverified questions (dev)"
          options={[{ v: false, label: 'Off' }, { v: true, label: 'Allow' }]}
          value={!!st.allowUnverified}
          onPick={(v) => set({ allowUnverified: v })}
          note={st.allowUnverified
            ? 'Serving drafted questions that have NOT been fact-checked. Turn off once you approve some at /questions.'
            : 'Only verified questions will be served.'}
        />

        {music && music.vibes && music.vibes.length > 1 && (
          <div className="tv-series-picker">
            <div className="tv-series-label">Vibes</div>
            <div className="tv-series-options">
              {music.allowAll && (
                <button
                  className={'lp-btn lp-btn--ghost' + (music.vibeId === ALL_VIBES_ID ? ' tv-series-selected' : '')}
                  onClick={() => music.onPickVibe(ALL_VIBES_ID)}
                >All Vibes</button>
              )}
              {music.vibes.map((v) => {
                const empty = !(v.tracks && v.tracks.length);
                return (
                  <button
                    key={v.id}
                    className={'lp-btn lp-btn--ghost' + (music.vibeId === v.id ? ' tv-series-selected' : '')}
                    disabled={empty}
                    onClick={() => music.onPickVibe(v.id)}
                  >{v.name}{empty ? ' (no songs)' : ''}</button>
                );
              })}
            </div>
          </div>
        )}

        <div className="tv-bot-picker">
          <div className="tv-series-label">CPU players</div>
          <div className="tv-bot-stepper">
            <button type="button" className="lp-btn lp-btn--ghost tv-bot-step"
              aria-label="Remove a CPU player" disabled={botCount === 0}
              onClick={() => sendAction('removeBot')}>−</button>
            <span className="tv-bot-count">{botCount}<span className="of"> / 4</span></span>
            <button type="button" className="lp-btn lp-btn--ghost tv-bot-step"
              aria-label="Add a CPU player" disabled={!canAddBot}
              onClick={() => { sfx.enteredRoom(); sendAction('addBot'); }}>+</button>
          </div>
        </div>

        {snap.players.length === 0 ? (
          <div className="tv-sub lp-pulse">Waiting for the first player to join…</div>
        ) : (
          <div className="tv-player-chips">
            {snap.players.map((p) => (
              <div key={p.id} className={'chip lp-fade-in' + (p.isBot ? ' is-bot' : '')}>
                <span className="emoji"><PieceVisual id={p.piece} size={42} glow /></span>
                <span className="name">{p.name}</span>
                {p.isBot && <span className="bot-badge">CPU</span>}
              </div>
            ))}
          </div>
        )}
        {snap.players.length >= 2 && (
          <button className="lp-btn tv-start-btn" onClick={() => sendAction('startGame')}>Start the Game</button>
        )}
        {isDev() && snap.players.length === 0 && (
          <button className="lp-btn lp-btn--ghost tv-start-btn"
            onClick={() => getSocket().emit('tv:simulate', () => {})}>
            Simulate a game (dev)
          </button>
        )}
      </div>
    </div>
  );
}

// One row of mutually-exclusive setting buttons.
function Picker({ label, options, value, onPick, note }) {
  return (
    <div className="tv-series-picker">
      <div className="tv-series-label">{label}</div>
      <div className="tv-series-options">
        {options.map((o) => (
          <button
            key={String(o.v)}
            className={'lp-btn lp-btn--ghost' + (value === o.v ? ' tv-series-selected' : '')}
            onClick={() => onPick(o.v)}
          >{o.label}</button>
        ))}
      </div>
      {note && <div className="tv-mode-note">{note}</div>}
    </div>
  );
}

// Compact -/+ control for the tunable movement values.
function Stepper({ label, value, onSet, min = 0, max = 6 }) {
  const v = typeof value === 'number' ? value : 0;
  return (
    <span className="tv-stepper">
      <button className="lp-btn lp-btn--ghost tv-bot-step" disabled={v <= min}
        onClick={() => onSet(v - 1)} aria-label={'Less: ' + label}>−</button>
      <span className="tv-stepper-value">{v}</span>
      <button className="lp-btn lp-btn--ghost tv-bot-step" disabled={v >= max}
        onClick={() => onSet(v + 1)} aria-label={'More: ' + label}>+</button>
      <span className="tv-stepper-label">{label}</span>
    </span>
  );
}

// ─── ROUND_INTRO ───
function RoundIntroScreen({ snap }) {
  useEffect(() => { sfx.roundIntro(); }, []);
  const duel = snap.duel;
  const a = duel && snap.players.find((p) => p.id === duel.challengerId);
  const b = duel && snap.players.find((p) => p.id === duel.opponentId);
  const picking = snap.duelPick && !snap.duelPick.opponentId
    && snap.players.find((p) => p.id === snap.duelPick.playerId);
  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Next up</div>
      <div className="tv-h1">Round {snap.round}</div>
      {snap.question && <div className="tv-word-inline">{snap.question.category}</div>}
      {duel && a && b && <div className="tv-sub tv-duel-line">⚡ Duel — {a.name} vs {b.name}</div>}
      {picking && <div className="tv-sub tv-duel-line lp-pulse">⚡ {picking.name} is picking a rival…</div>}
    </div>
  );
}

// ─── ANSWERING ───
// The question is the whole screen. No choices — everyone types what they
// genuinely believe the answer is.
function AnsweringScreen({ snap }) {
  useCheckInDing(snap.answeredPlayerIds || []);
  useEffect(() => { sfx.wordReveal(); }, []);
  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Round {snap.round} — {snap.question && snap.question.category}</div>
      <div className="tv-question">{snap.question && snap.question.question}</div>
      <div className="tv-sub">Type what you think the real answer is.</div>
      <Countdown deadline={snap.phaseEndsAt} />
      <CheckInStrip snap={snap} doneIds={snap.answeredPlayerIds || []} />
    </div>
  );
}

// ─── BLUFFING ───
// Only players who got it right are writing. The TV shows how MANY knew it,
// never who — naming them would hand the room a map of the ballot.
function BluffingScreen({ snap }) {
  useCheckInDing(snap.bluffedPlayerIds || []);
  useEffect(() => { sfx.bluffPhase(); }, []);
  const n = snap.correctCount || 0;
  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Round {snap.round} — somebody knows</div>
      <div className="tv-question">{snap.question && snap.question.question}</div>
      <div className="tv-h1 lp-pulse">
        {n === 0 ? 'Nobody knew it!' : n === 1 ? '1 player knew it' : n + ' players knew it'}
      </div>
      <div className="tv-sub">They're writing lies about it right now. Everyone else, sit tight.</div>
      <Countdown deadline={snap.phaseEndsAt} />
      <CheckInStrip snap={snap} doneIds={snap.bluffedPlayerIds || []} onlyIds={snap.bluffingPlayerIds || []} />
    </div>
  );
}

// ─── VOTING ───
function VotingScreen({ snap }) {
  useCheckInDing(snap.votedPlayerIds || []);
  useEffect(() => { sfx.votingIntro(); }, []);
  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Round {snap.round} — which one is true?</div>
      <div className="tv-question">{snap.question && snap.question.question}</div>
      <BallotGrid ballot={snap.ballot} />
      <Countdown deadline={snap.phaseEndsAt} />
      <div className="tv-sub">Only the players who missed it get to vote.</div>
      <CheckInStrip snap={snap} doneIds={snap.votedPlayerIds || []} onlyIds={snap.votingPlayerIds || []} />
    </div>
  );
}

// ─── REVEAL ───
// Two beats only, to keep the game moving: the truth with a dramatic build,
// then ONE page showing every bluff and who fell for it (see BluffsSummary).
function RevealScreen({ snap }) {
  const order = snap.revealOrder || [];
  const ballot = snap.ballot || [];
  const stepIdx = Math.min(snap.revealIndex, Math.max(0, order.length - 1));
  const letter = order[stepIdx];
  const isSummary = letter === '__BLUFFS__';
  const current = ballot.find((b) => b.letter === letter);
  const isTruth = !!(current && current.isTruth);
  const voters = (current && current.voters) || [];
  const fooled = voters.length > 0;
  const buildMs = (!isSummary && stepIdx === 0) ? 3000 : 0;
  const [phase, setPhase] = useState(buildMs > 0 ? 'building' : 'showing');

  useEffect(() => {
    if (isSummary) { setPhase('showing'); sfx.bluff(); return; }
    if (buildMs > 0) {
      setPhase('building');
      sfx.heartbeat();
      const id = setTimeout(() => {
        sfx.heartbeatStop();
        setPhase('showing');
        sfx.reveal(true, fooled);
      }, buildMs);
      return () => { clearTimeout(id); sfx.heartbeatStop(); };
    }
    setPhase('showing');
    sfx.reveal(false, fooled);
  }, [stepIdx]);

  if (isSummary) return <BluffsSummary snap={snap} />;
  if (!current) return null;
  const playerById = (id) => snap.players.find((p) => p.id === id);
  const authors = (current.authorIds || []).map(playerById).filter(Boolean);

  if (phase === 'building') {
    return (
      <div className="tv-stage">
        <div className="tv-eyebrow">Round {snap.round} — the real answer is…</div>
        <div className="tv-reveal-build is-real" key={'build-' + letter}>
          <div className="tv-reveal-build-label">{snap.question && snap.question.question}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* The charge darkened the board during the heartbeat; this holds that
          darkness through the answer reveal, then fades it back to normal
          brightness slowly. Only for the truth reveal (the one that built). */}
      {buildMs > 0 && <div className="tv-reveal-dim-clear" key={'dim-' + letter} />}
      <div className="tv-stage tv-stage--panel" style={{ position: 'relative', zIndex: 1 }}>
      <div className="tv-eyebrow">Round {snap.round} — the real answer</div>
      <div className={'tv-reveal-card' + (isTruth ? ' is-truth' : ' is-lie')} key={'card-' + letter}>
        <div className="tv-reveal-tag">
          {isTruth ? 'THE TRUTH' : current.isDecoy ? 'House lie' : 'A lie'}
        </div>
        <div className="tv-reveal-text">{current.text}</div>
        {!isTruth && authors.length > 0 && (
          <div className="tv-reveal-authors">written by {authors.map((a) => a.name).join(' & ')}</div>
        )}
        <div className="tv-reveal-voters">
          {voters.length === 0
            ? (isTruth ? 'Nobody found it.' : 'Fooled nobody.')
            : (
              <>
                <span className="tv-reveal-voters-label">{isTruth ? 'Found it:' : 'Fooled:'}</span>
                {voters.map(playerById).filter(Boolean).map((p) => (
                  <span className="tv-reveal-voter" key={p.id}>
                    <PieceVisual id={p.piece} size={40} />{p.name}
                  </span>
                ))}
              </>
            )}
        </div>
      </div>
      {isTruth && snap.skipReason === 'everyone-knew' && (
        <div className="tv-skip-note">
          Everyone knew it — nobody left to fool, so no lies this round.
        </div>
      )}
      {isTruth && snap.skipReason === 'nobody-knew' && (
        <div className="tv-skip-note">
          Nobody knew it — the whole ballot was honest guesses.
        </div>
      )}
      {isTruth && <KnewItStrip snap={snap} />}
      </div>
    </>
  );
}

// Every bluff on ONE page: the lie, who wrote it, and who fell for it. Replaces
// the old one-card-at-a-time reveal so the "who fooled who" beat lands fast and
// the game keeps its momentum. AutoFit scales the whole grid to the TV, so it's
// always a single page — never a scroll.
function BluffsSummary({ snap }) {
  const ballot = snap.ballot || [];
  const playerById = (id) => snap.players.find((p) => p.id === id);
  const bluffs = ballot.filter((b) => !b.isTruth &&
    ((b.authorIds || []).length || (b.voters || []).length));

  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Round {snap.round} — who fooled who</div>
      <div className="tv-bluffs-grid">
        {bluffs.map((b) => {
          const authors = (b.authorIds || []).map(playerById).filter(Boolean);
          const voters = (b.voters || []).map(playerById).filter(Boolean);
          return (
            <div key={b.letter} className="tv-bluff-card">
              <div className="tv-bluff-lie">&ldquo;{b.text}&rdquo;</div>
              <div className="tv-bluff-by">
                {b.isDecoy
                  ? 'House lie'
                  : authors.length
                    ? 'by ' + authors.map((a) => a.name).join(' & ')
                    : 'Unclaimed'}
              </div>
              <div className="tv-bluff-fooled">
                {voters.length === 0
                  ? <span className="tv-bluff-nofool">fooled nobody</span>
                  : (
                    <>
                      <span className="tv-bluff-fooled-label">fooled</span>
                      {voters.map((p) => (
                        <span className="tv-bluff-voter" key={p.id}>
                          <PieceVisual id={p.piece} size={44} />{p.name}
                        </span>
                      ))}
                    </>
                  )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Who actually knew the answer — shown alongside the truth card.
function KnewItStrip({ snap }) {
  const results = snap.lastResults || {};
  const knew = snap.players.filter((p) => results[p.id] && results[p.id].correct);
  if (!knew.length) return <div className="tv-sub">Not a soul. The whole table was guessing.</div>;
  return (
    <div className="tv-result-list">
      {knew.map((p) => (
        <div key={p.id} className="tv-result is-correct">
          <PieceVisual id={p.piece} size={48} />
          <span className="who">{p.name}</span>
          <span className="mark">knew it</span>
        </div>
      ))}
    </div>
  );
}

// ─── REVIEW ───
// A wrongly-judged player disputed their answer; the other players are voting to
// overturn it. The TV shows the disputed answer vs. the truth, a live Yes/No
// tally, then the verdict before the next dispute (or scoring).
function ReviewStage({ snap }) {
  const rv = snap.review;
  const enteredRef = useRef(false);
  useEffect(() => { if (!enteredRef.current) { enteredRef.current = true; sfx.votingIntro(); } }, []);
  const resolved = !!(rv && rv.resolved);
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (resolved && !resolvedRef.current) {
      resolvedRef.current = true;
      if (rv.passed) sfx.reveal(true, false); else sfx.bluff();
    }
  }, [resolved]);

  if (!rv) {
    return <div className="tv-stage tv-stage--panel"><div className="tv-eyebrow">Answer review</div></div>;
  }

  return (
    <div className="tv-stage tv-stage--panel">
      <div className="tv-eyebrow">Round {snap.round} — answer review</div>
      <div className="tv-review-head">
        <PieceVisual id={rv.piece} size={64} />
        <div className="tv-review-claim"><span className="who">{rv.name}</span> says this should count:</div>
      </div>
      <div className="tv-review-answers">
        <div className="tv-review-answer is-claim">
          <div className="tv-review-tag">Their answer</div>
          <div className="tv-review-text">&ldquo;{rv.answerText}&rdquo;</div>
        </div>
        <div className="tv-review-answer is-truth">
          <div className="tv-review-tag">The real answer</div>
          <div className="tv-review-text">&ldquo;{rv.truth}&rdquo;</div>
        </div>
      </div>

      {resolved ? (
        <div className={'tv-review-verdict ' + (rv.passed ? 'is-pass' : 'is-deny')}>
          {rv.passed ? 'Overturned — it counts!' : 'Denied — the ruling stands.'}
          <span className="tv-review-verdict-tally">Yes {rv.yes} · No {rv.no}</span>
        </div>
      ) : (
        <>
          <div className="tv-review-tally">
            <div className="tv-review-tally-side is-yes"><span className="n">{rv.yes}</span><span className="l">Yes</span></div>
            <div className="tv-review-tally-side is-no"><span className="n">{rv.no}</span><span className="l">No</span></div>
          </div>
          <div className="tv-sub">{rv.voted} of {rv.voterCount} voted — the other players decide, majority overturns it.</div>
          <Countdown deadline={snap.phaseEndsAt} silent />
        </>
      )}
      {rv.remaining > 0 && <div className="tv-review-more">{rv.remaining} more to review</div>}
    </div>
  );
}

// ─── SCORING ───
// The card holds centered while pieces are frozen, then fades so the board is
// clear before anything slides. The server applies positions on the same
// schedule (SLIDE_LEAD_MS in game.js) — if the two drift, fix the server.
function MovementScreen({ snap }) {
  useEffect(() => { sfx.score(); }, []);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHidden(true), 4000);
    return () => clearTimeout(t);
  }, []);
  const results = snap.lastResults || {};
  const sorted = [...snap.players].sort((a, b) => b.position - a.position);
  return (
    <>
      <div className={'tv-scoring-backdrop' + (hidden ? ' is-hidden' : '')} />
      <div className={'tv-scorecard' + (hidden ? ' is-hidden' : '')}>
        <div className="tv-eyebrow">Round {snap.round} — moving up the board</div>
        <div className="tv-leaderboard">
          {sorted.map((p, i) => {
            const r = results[p.id] || {};
            const gained = r.spaces || 0;
            return (
              <div key={p.id} className="row">
                <span className="rank">{i + 1}</span>
                <span className="emoji"><PieceVisual id={p.piece} size={72} /></span>
                <span className="name">
                  {p.name}
                  {r.correct && <span className="tv-row-flair">knew it</span>}
                  {r.votesPulled > 0 && <span className="tv-row-flair">fooled {r.votesPulled}</span>}
                  {r.duel === 'won' && <span className="tv-row-flair">⚡ duel</span>}
                  {r.advanced > 0 && <span className="tv-row-flair">→ arrow +{r.advanced}</span>}
                  {r.landedBonus && <span className="tv-row-flair">☕ double next</span>}
                </span>
                <span className="delta">{gained > 0 ? '+' + gained : gained < 0 ? String(gained) : '·'}</span>
                <span className="total">{p.position}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── GAME_OVER ───
function GameOverScreen({ snap }) {
  const winner = snap.players.find((p) => p.id === snap.winnerId)
    || [...snap.players].sort((a, b) => b.position - a.position)[0];
  const sorted = [...snap.players].sort((a, b) => b.position - a.position || b.correct - a.correct);
  useEffect(() => { sfx.win(); }, []);
  return (
    <div className="tv-stage">
      <div className="tv-winner-hero">
        <div className="tv-winner-crown" aria-hidden="true">👑</div>
        <div className="tv-winner-piece"><PieceVisual id={winner && winner.piece} size={188} glow /></div>
        <div className="tv-winner-title">Winner</div>
        <div className="tv-winner-name">{winner ? winner.name : 'The end.'}</div>
        {winner && <div className="tv-winner-sub">{winner.correct} right · fooled people {winner.fooled} times</div>}
      </div>
      <div className="tv-leaderboard">
        {sorted.map((p, i) => (
          <div key={p.id} className="row">
            <span className="rank">{i + 1}</span>
            <span className="emoji"><PieceVisual id={p.piece} size={64} /></span>
            <span className="name">{p.name}</span>
            <span className="delta">{p.correct} ✓ · {p.fooled} fooled</span>
            <span className="total">{p.position}</span>
          </div>
        ))}
      </div>
      <div className="tv-gameover-actions">
        <button className="lp-btn" onClick={() => sendAction('playAgain')}>Play again</button>
        <button className="lp-btn lp-btn--ghost" onClick={() => sendAction('returnToLobby')}>Back to lobby</button>
      </div>
    </div>
  );
}

// The ballot as a grid of lettered cards — used during VOTING.
function BallotGrid({ ballot }) {
  if (!ballot || !ballot.length) return null;
  return (
    <div className="tv-ballot tv-choices">
      {ballot.map((b) => (
        <div key={b.letter} className="entry tv-choice">
          <span className="letter">{b.letter}</span>
          <span className="text">{b.text}</span>
        </div>
      ))}
    </div>
  );
}

// Who has acted this phase — the row of pieces with checkmarks. `onlyIds`
// optionally restricts the strip to a subset of players (e.g. only the
// writers during bluffing); omit it to show everyone.
function CheckInStrip({ snap, doneIds, onlyIds }) {
  const players = (onlyIds && onlyIds.length)
    ? snap.players.filter((p) => onlyIds.includes(p.id))
    : snap.players;
  return (
    <div className="tv-submission-list">
      {players.map((p) => {
        const done = doneIds.includes(p.id);
        return (
          <div key={p.id} className={'item ' + (done ? 'done' : '')}>
            <span className="check">
              {done && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="5 13 10 18 19 7" />
                </svg>
              )}
            </span>
            <PieceVisual id={p.piece} size={64} />
            <span>{p.name}</span>
          </div>
        );
      })}
    </div>
  );
}

// Fires the check-in ding each time the answered list grows. Initialized to
// the current length so a re-mount doesn't retrigger for existing answers.
function useCheckInDing(doneIds) {
  const prevLenRef = useRef(doneIds.length);
  useEffect(() => {
    const len = doneIds.length;
    if (len > prevLenRef.current) sfx.submitDing();
    prevLenRef.current = len;
  }, [doneIds.length]);
}

// Seconds remaining at/below which the timer turns red, and when it starts
// ticking audibly. One constant each so visual and audio can't drift apart.
// Both are lower than Wilderdash's because a 20s answer clock is short —
// urgency has to land in the last few seconds, not most of the phase.
const URGENT_AT = 8;
const TICK_FROM = 15;

function Countdown({ deadline, silent }) {
  const calc = () => (deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null);
  const [s, setS] = useState(calc);
  useEffect(() => {
    if (!deadline) { setS(null); return; }
    // Self-correcting scheduler: each update re-aligns to the next whole
    // second off the real clock, so the displayed number flips exactly in
    // step with the server deadline instead of drifting with a fixed poll.
    let timeoutId;
    const step = () => {
      const remMs = deadline - Date.now();
      setS(Math.max(0, Math.ceil(remMs / 1000)));
      if (remMs <= 0) return;
      let next = remMs % 1000;
      if (next <= 0) next += 1000;
      timeoutId = setTimeout(step, next);
    };
    step();
    return () => clearTimeout(timeoutId);
  }, [deadline]);

  const prevSRef = useRef(s);
  const urgentActiveRef = useRef(false);
  const fastTickRef = useRef(null);
  function stopFastTicks() {
    if (fastTickRef.current) { clearInterval(fastTickRef.current); fastTickRef.current = null; }
  }
  useEffect(() => {
    const prev = prevSRef.current;
    if (silent) { prevSRef.current = s; return; }
    if (s != null && prev != null && s < prev && s > 0 && s <= TICK_FROM && s >= URGENT_AT) sfx.tick();
    if (s != null && s > 0 && s < URGENT_AT && !urgentActiveRef.current) {
      urgentActiveRef.current = true;
      sfx.tick();
      fastTickRef.current = setInterval(() => sfx.tick(), 250);
    }
    if (s === 0 && prev != null && prev > 0) {
      stopFastTicks();
      urgentActiveRef.current = false;
      sfx.buzzer();
    }
    prevSRef.current = s;
  }, [s]);
  useEffect(() => () => { stopFastTicks(); urgentActiveRef.current = false; }, [deadline]);

  if (s == null) return null;
  return <div className={'tv-timer-inline ' + (s < URGENT_AT ? 'urgent' : '')}>{s}s</div>;
}
