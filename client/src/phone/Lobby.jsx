import React, { useState } from 'react';
import { sendAction } from '../lib/socket';
import PieceVisual from '../lib/PieceVisual';
import RulesOverlay from '../lib/RulesOverlay';

// Phone lobby view: shows who's in and lets anyone with 2+ players start.
export default function Lobby({ snap }) {
  const enough = snap.players.length >= 2;
  const [showRules, setShowRules] = useState(false);
  return (
    <div className="phone-shell phone-shell--splash">
      <img className="phone-logo" src="/central-perkd-logo.png" alt="Central Perk'd" />
      <div className="lp-pill" style={{ alignSelf: 'center', margin: '0 auto 12px' }}>Room {snap.code}</div>
      <h1 className="phone-h1">Lobby</h1>
      <p className="phone-sub">You're in! Waiting for everyone to join.</p>

      <div className="phone-stack" style={{ marginBottom: 24 }}>
        {snap.players.map((p) => (
          <div key={p.id} className="score-row">
            <span className="emoji"><PieceVisual id={p.piece} size={48} /></span>
            <span className="name">
              {p.name}
              {p.id === snap.me.id && <span style={{ color: 'var(--gold)', marginLeft: 8, fontSize: '0.85rem' }}>(you)</span>}
            </span>
            {!p.connected && <span style={{ color: 'var(--cream-fade)', fontSize: '0.85rem' }}>offline</span>}
          </div>
        ))}
      </div>

      <button
        className="lp-btn"
        style={{ width: '100%' }}
        disabled={!enough}
        onClick={() => sendAction('startGame')}
      >
        {enough ? 'Start Game' : 'Need 2+ players'}
      </button>

      <button
        type="button"
        className="lp-btn lp-btn--ghost"
        style={{ width: '100%', marginTop: 12 }}
        onClick={() => setShowRules(true)}
      >
        How to play
      </button>

      {showRules && <RulesOverlay snap={snap} onClose={() => setShowRules(false)} />}
    </div>
  );
}

