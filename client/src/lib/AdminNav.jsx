import React from 'react';
import './AdminNav.css';

// Persistent top navigation shared by every admin page so you can jump between
// the tools (and back to the main Admin page) without hunting for URLs. Pass
// `current` (one of the keys below) to highlight the active tool, and
// `onSignOut` to show the shared sign-out button.
const NAV = [
  { href: '/admin', label: 'Admin', key: 'admin' },
  { href: '/sounds', label: 'Sounds', key: 'sounds' },
  { href: '/playlist', label: 'Music', key: 'playlist' },
  { href: '/tv?adjust', label: 'Board Path', key: 'board' }
];

export default function AdminNav({ current, onSignOut }) {
  return (
    <div className="adnav">
      <a className="adnav-brand" href="/admin">
        <span className="adnav-brand-mark" aria-hidden="true">☕</span> Central Perk&rsquo;d
      </a>
      <nav className="adnav-links">
        {NAV.map((n) => (
          <a key={n.key} href={n.href}
            className={'adnav-link' + (n.key === current ? ' is-active' : '')}>
            {n.label}
          </a>
        ))}
      </nav>
      {onSignOut && (
        <button type="button" className="adnav-signout" onClick={onSignOut}>Sign out</button>
      )}
    </div>
  );
}
