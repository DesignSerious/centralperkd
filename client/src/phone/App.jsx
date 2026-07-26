import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getSocket, sendAction } from '../lib/socket';
import { getToken, refreshMe } from '../lib/auth';
import { pieceById, isPhotoPiece, isAiPiece, pieceUrlWithExpression, expressionForState, preloadAiPiece } from '../lib/pieces';
import * as sfx from '../lib/sfx';
import PauseOverlay from '../lib/PauseOverlay';
import Join from './Join';
import Lobby from './Lobby';
import Wait from './Wait';
import Answer from './Answer';
import Bluff from './Bluff';
import FaceOff from './FaceOff';
import Vote from './Vote';
import Review from './Review';
import Watch from './Watch';

// Phone controller. Owns connection lifecycle, restoration from
// localStorage, and routing to a screen based on the server-pushed state.
export default function App() {
  const [snap, setSnap] = useState(null);
  const [stored, setStored] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('cperkd_player') || 'null');
      return s && s.code && s.playerId ? s : null;
    } catch (e) { return null; }
  });
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  const prevStateRef = useRef(null);
  const socketRef = useRef(null);

  // First-round intro: when the lobby flips into round 1, hold a "Get ready!"
  // overlay for 3 seconds so the player isn't dropped straight into a screen
  // they weren't looking at. Skips on reconnect (prev state wasn't LOBBY) and
  // on subsequent series games (round becomes 1 again, but coming from
  // SCORING/GAME_OVER, not LOBBY).
  // Keep the intro timer outside the effect's cleanup lifecycle. Returning
  // a cleanup that clears the timeout from an effect that re-runs on every
  // state push meant a fast LOBBY -> WORD_SELECTION -> ANNOUNCING sequence
  // would cancel the timer before it could dismiss the intro, stranding the
  // player on the "Get ready!" screen until they reloaded.
  const introTimerRef = useRef(null);
  useEffect(() => {
    if (!snap) return;
    const prev = prevStateRef.current;
    prevStateRef.current = snap.state;
    if (prev === 'LOBBY' && snap.state !== 'LOBBY' && snap.round === 1) {
      setShowIntro(true);
      if (introTimerRef.current) clearTimeout(introTimerRef.current);
      introTimerRef.current = setTimeout(() => {
        setShowIntro(false);
        introTimerRef.current = null;
      }, 3000);
    }
  }, [snap && snap.state, snap && snap.round]);
  // Tidy up the timer if the component unmounts mid-intro (leave room etc).
  useEffect(() => () => {
    if (introTimerRef.current) clearTimeout(introTimerRef.current);
  }, []);

  useEffect(() => {
    const s = getSocket();
    socketRef.current = s;
    const onState = (data) => setSnap(data);
    s.on('state', onState);
    return () => { s.off('state', onState); };
  }, []);

  // Revalidate the saved account token on load, and pull fresh stats each
  // time a game finishes so the profile card is up to date. No-op for guests.
  useEffect(() => { refreshMe(); }, []);
  useEffect(() => {
    if (snap && snap.state === 'GAME_OVER') refreshMe();
  }, [snap && snap.state]);

  // Eagerly preload every player's AI expression variants the moment we
  // learn about them, so the first cutscene that needs one doesn't show
  // the neutral fallback while the variant is fetched. Module-scoped Set
  // ensures we don't refetch the same piece on every render.
  useEffect(() => {
    if (!snap || !snap.players) return;
    snap.players.forEach((p) => preloadAiPiece(p && p.piece));
  }, [snap && snap.players && snap.players.map((p) => p && p.piece).join('|')]);

  // Global UI sound feedback. Big action buttons (.lp-btn) and choice tiles
  // get the confirm chime; smaller selections (piece tiles) get a soft tap.
  useEffect(() => {
    function onClick(e) {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.lp-btn') || t.closest('.word-choice') || t.closest('.vote-choice')) {
        sfx.confirm();
      } else if (t.closest('.piece-tile') || t.closest('.badge-leave')) {
        sfx.tap();
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // On reconnect, automatically rejoin the saved room.
  useEffect(() => {
    if (!stored) return;
    const s = socketRef.current;
    function rejoin() {
      s.emit('player:join', { code: stored.code, name: stored.name, piece: stored.piece, playerId: stored.playerId, authToken: getToken() }, (res) => {
        if (!res || !res.ok) {
          // The room is gone — clear our memory.
          localStorage.removeItem('cperkd_player');
          setStored(null);
        }
      });
    }
    s.on('connect', rejoin);
    if (s.connected) rejoin();
    return () => s.off('connect', rejoin);
  }, [stored && stored.playerId]);

  // Drop the player back to a fresh Join screen. Clears localStorage and
  // bounces the socket so the server marks them as disconnected.
  function confirmLeave() {
    try { localStorage.removeItem('cperkd_player'); } catch (e) {}
    const s = socketRef.current;
    if (s) {
      s.disconnect();
      s.connect();
    }
    setConfirmingLeave(false);
    setSnap(null);
    setStored(null);
  }
  function requestLeave() { setConfirmingLeave(true); }
  function cancelLeave() { setConfirmingLeave(false); }

  if (!stored) {
    return <Join onJoined={(s) => { setStored(s); }} />;
  }
  if (!snap) {
    return (
      <>
        <PlayerBadge stored={stored} onLeave={requestLeave} />
        <div className="phone-shell phone-shell--splash">
          <img className="phone-logo" src="/central-perkd-logo.png" alt="Central Perk'd" />
          <div className="phone-status">
            <div className="lp-spinner spinner" />
            Reconnecting…
          </div>
        </div>
        {confirmingLeave && <LeaveModal onCancel={cancelLeave} onConfirm={confirmLeave} />}
      </>
    );
  }

  const state = snap.state;
  // Route to the right screen based on the server-pushed phase.
  // Routing depends on the player's own verdict, which the server sends as
  // snap.myAnswerCorrect: right players write a lie and skip voting, wrong
  // players skip bluffing and vote. Nobody sees the other branch.
  // ANSWERING doubles as the front half of the bluff window. The server judges
  // every answer the moment it lands, so a player who nailed it is handed the
  // lie screen immediately rather than sitting out the rest of the clock.
  // myAnswerCorrect is null until the verdict resolves — that gap is its own
  // screen, so "checking" never reads as "waiting for everyone else".
  const earlyBluff = state === 'ANSWERING' && !snap.canAnswer && snap.myAnswerCorrect === true;

  let screen;
  if (state === 'LOBBY') screen = <Lobby snap={snap} />;
  else if (state === 'ROUND_INTRO') screen = <Wait snap={snap} mode="round-intro" />;
  else if (state === 'ANSWERING') {
    screen = snap.canAnswer ? <Answer snap={snap} />
      : earlyBluff ? <Bluff snap={snap} early />
        : snap.myAnswerCorrect == null ? <Wait snap={snap} mode="judging" />
          : <Wait snap={snap} mode="answered" />;
  } else if (state === 'BLUFFING') {
    screen = snap.myAnswerCorrect ? <Bluff snap={snap} /> : <Wait snap={snap} mode="bluff-wait" />;
  } else if (state === 'VOTING') {
    screen = snap.myAnswerCorrect ? <Wait snap={snap} mode="vote-wait" /> : <Vote snap={snap} />;
  } else if (state === 'REVIEW') {
    screen = <Review snap={snap} />;
  } else if (state === 'FACE_OFF') {
    // Finalists and spectators share one screen — it branches internally, and
    // the sudden-death beats are the finale for everybody watching.
    screen = <FaceOff snap={snap} />;
  } else if (state === 'REVEAL' || state === 'SCORING' || state === 'GAME_OVER') {
    screen = <Watch snap={snap} />;
  } else screen = <div className="phone-shell"><div className="phone-status">Loading…</div></div>;

  // Phase key for the entrance animation. REVEAL → SCORING → GAME_OVER all
  // render inside <Watch>, which owns its own sound cues — re-mounting it
  // between those phases would replay them, so they share one key. <Bluff> is
  // the same story across the ANSWERING → BLUFFING seam: a correct player is
  // already on it, and a new key there would remount and replay the "you nailed
  // it" sting a second time.
  const phaseKey = (state === 'SCORING' || state === 'GAME_OVER') ? 'WATCH'
    : (earlyBluff || state === 'BLUFFING') ? 'BLUFF'
      : state;

  return (
    <>
      <PlayerBadge snap={snap} onLeave={requestLeave} />
      {showIntro ? (
        <GetReadyIntro />
      ) : (
        <div className="phase-fade" key={phaseKey}>{screen}</div>
      )}
      {confirmingLeave && <LeaveModal onCancel={cancelLeave} onConfirm={confirmLeave} />}
      {snap.paused && <PauseOverlay />}
    </>
  );
}

function GetReadyIntro() {
  return (
    <div className="phone-shell get-ready-intro">
      <div className="get-ready-text lp-pulse">Get ready!</div>
    </div>
  );
}

// Styled confirmation dialog for leaving the room. Matches the in-game
// canonical button look (sharp corners, plum outline, Playfair Display).
function LeaveModal({ onCancel, onConfirm }) {
  return (
    <div className="lp-modal-backdrop" onClick={onCancel}>
      <div className="lp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="lp-modal-title">Leave the game?</div>
        <div className="lp-modal-body">
          You'll return to the join screen. Your seat in this room will open up.
        </div>
        <div className="lp-modal-actions">
          <button type="button" className="lp-btn lp-btn--ghost" onClick={onCancel}>Stay</button>
          <button type="button" className="lp-btn" onClick={onConfirm}>Leave</button>
        </div>
      </div>
    </div>
  );
}

// Inline volume control. Renders a speaker icon + slim slider in the badge.
// Writes through to sfx.setMasterVolume which persists to localStorage and
// applies to every phone-side sound (MP3 pools + synthesized tones), so the
// player's preference carries across every game screen and survives reloads.
function BadgeVolume() {
  const [vol, setVol] = useState(() => sfx.getMasterVolume());
  // Remember the last audible level so the speaker-icon mute toggle can
  // restore it (falls back to full volume if they were already at 0).
  const lastVolRef = useRef(vol > 0 ? vol : 1);
  useEffect(() => { if (vol > 0) lastVolRef.current = vol; }, [vol]);
  function toggleMute() {
    if (vol > 0) {
      lastVolRef.current = vol;
      sfx.setMasterVolume(0);
    } else {
      sfx.setMasterVolume(lastVolRef.current > 0 ? lastVolRef.current : 1);
    }
  }

  // Re-sync from the source of truth on every mount/remount before paint.
  // If this component unmounts (e.g. PlayerBadge gets a different prop shape
  // when transitioning between !snap and gameplay branches) and remounts,
  // pull the current master so the slider never shows a stale initial value.
  useLayoutEffect(() => {
    setVol(sfx.getMasterVolume());
  }, []);

  // Subscribe to any future changes so the slider always reflects the
  // canonical _masterVolume, even if it was changed from somewhere outside
  // this component (other tab via storage event, future debug panel, etc.).
  useEffect(() => {
    const unsub = sfx.subscribeMasterVolume((v) => setVol(v));
    function onStorage(e) {
      if (e.key === 'cperkd_phone_volume' && e.newValue != null) {
        const v = parseFloat(e.newValue);
        if (!isNaN(v)) {
          sfx.setMasterVolume(Math.max(0, Math.min(1, v)));
        }
      }
    }
    window.addEventListener('storage', onStorage);
    return () => {
      unsub();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  function onChange(e) {
    const v = Math.max(0, Math.min(1, e.target.value / 100));
    setVol(v);
    sfx.setMasterVolume(v);
  }
  const muted = vol <= 0;
  return (
    <div className="badge-volume" title="Sound volume">
      <button
        type="button"
        className="badge-volume-icon"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z" fill="currentColor" fillOpacity="0.25"/>
            <path d="M17 9 L21 13"/>
            <path d="M21 9 L17 13"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z" fill="currentColor" fillOpacity="0.25"/>
            <path d="M16 8.5 C17.5 10 17.5 14 16 15.5"/>
          </svg>
        )}
      </button>
      <input
        className="badge-volume-slider"
        type="range" min="0" max="100" step="1"
        value={Math.round(vol * 100)}
        onChange={onChange}
        aria-label="Sound volume"
      />
    </div>
  );
}

// Thin always-visible identity bar at the top of every gameplay screen.
function PlayerBadge({ snap, stored, onLeave }) {
  const me = snap && snap.me;
  const pieceId = me ? me.piece : (stored && stored.piece);
  const name = me ? me.name : (stored && stored.name);
  if (!pieceId && !name) return null;
  const isPhoto = isPhotoPiece(pieceId);
  const isAi = isAiPiece(pieceId);
  const piece = (isPhoto || isAi) ? null : pieceById(pieceId);
  const aiExpression = isAi ? expressionForState(snap && snap.state) : 'neutral';
  const aiSrc = isAi ? pieceUrlWithExpression(pieceId, aiExpression) : pieceId;
  // Pause is only meaningful inside an active round; hide the button in
  // lobby and game-over so it doesn't look like a do-nothing button. The
  // resume action lives entirely in the PauseOverlay.
  const canPause = snap && snap.state && snap.state !== 'LOBBY' && snap.state !== 'GAME_OVER' && !snap.paused;
  return (
    <div className="player-badge">
      <div className="player-badge-inner">
        {isPhoto
          ? <img src={pieceId} alt="Your photo" className="piece-img piece-img--photo" />
          : isAi
            ? <img
                src={aiSrc}
                alt="AI piece"
                className="piece-img"
                onError={(e) => { if (e.target.src !== pieceId) e.target.src = pieceId; }}
              />
            : (piece && piece.image
                ? <img src={piece.image} alt={piece.label} className="piece-img" />
                : <span className="piece-emoji">{piece ? piece.emoji : '✦'}</span>)}
        <span className="badge-name">{name}</span>
        {me && typeof me.score === 'number' && <span className="badge-score">{me.score}</span>}
        <BadgeVolume />
        {canPause && (
          <button type="button" className="badge-pause" onClick={() => { sfx.pause(); sendAction('pauseGame'); }} aria-label="Pause game" title="Pause game">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="7" y="5" width="3" height="14" />
              <rect x="14" y="5" width="3" height="14" />
            </svg>
          </button>
        )}
        {onLeave && (
          <button type="button" className="badge-leave" onClick={onLeave} aria-label="Leave game" title="Leave game">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {/* Door frame on the left + arrow pointing out to the right */}
              <path d="M10 4 H6 a2 2 0 0 0 -2 2 v12 a2 2 0 0 0 2 2 h4" />
              <path d="M14 8 l4 4 -4 4" />
              <path d="M18 12 H10" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
