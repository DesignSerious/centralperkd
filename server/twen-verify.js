/* TWEN ID — server-side token verification.
 *
 * Games that keep their data on their own server (Wilderdash's profiles,
 * Central Perk'd's rooms) cannot take the client's word for who someone is.
 * This turns an access token from twen.lol/auth.js into a trustworthy identity,
 * or throws.
 *
 * Copy this file into a game's server directory. It is deliberately dependency
 * free — node:crypto and fetch, both built in — so vendoring it costs nothing
 * and no game needs an npm install to gain accounts.
 *   source of truth: twen/twen-id/twen-verify.js
 *
 * Supabase signs these with ES256 and publishes the public keys as a JWKS, so
 * verification needs no shared secret: nothing here can mint a token, only
 * check one. The keys are cached and refetched when an unknown `kid` shows up,
 * which is what makes key rotation a non-event.
 */
'use strict';

const crypto = require('crypto');

const PROJECT = process.env.TWEN_SUPABASE_URL || 'https://khhfjixbfbcmoarnkrww.supabase.co';
const JWKS_URL = PROJECT.replace(/\/+$/, '') + '/auth/v1/.well-known/jwks.json';
const ISSUER = PROJECT.replace(/\/+$/, '') + '/auth/v1';

let keys = new Map();          // kid -> KeyObject
let fetchedAt = 0;
let inflight = null;

const MIN_REFETCH_MS = 60 * 1000;   // an unknown kid must not become a DoS

async function loadKeys(force) {
  const fresh = Date.now() - fetchedAt < MIN_REFETCH_MS;
  if (keys.size && (!force || fresh)) return keys;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('JWKS fetch failed: HTTP ' + res.status);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys || []) {
      if (!jwk.kid) continue;
      try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
      catch (e) { /* an unusable key is not a reason to reject the rest */ }
    }
    if (!next.size) throw new Error('JWKS had no usable keys');
    keys = next;
    fetchedAt = Date.now();
    return keys;
  })();
  try { return await inflight; } finally { inflight = null; }
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const ALGS = {
  ES256: { hash: 'sha256', opts: { dsaEncoding: 'ieee-p1363' } },
  RS256: { hash: 'sha256', opts: {} },
};

/**
 * Verify a TWEN access token.
 * Resolves to { id, email, name, anonymous } or throws.
 */
async function verifyTwenToken(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('not a token');
  const [h, p, s] = token.split('.');

  const header = b64urlJson(h);
  const alg = ALGS[header.alg];
  if (!alg) throw new Error('unexpected alg: ' + header.alg);

  let ks = await loadKeys(false);
  let key = header.kid && ks.get(header.kid);
  if (!key) {                                  // rotated key: refetch once, then give up
    ks = await loadKeys(true);
    key = header.kid && ks.get(header.kid);
  }
  if (!key) throw new Error('unknown signing key');

  const ok = crypto.verify(
    alg.hash,
    Buffer.from(h + '.' + p),
    { key, ...alg.opts },
    Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  );
  if (!ok) throw new Error('bad signature');

  // A valid signature over the wrong claims is still the wrong token: check who
  // issued it, who it was for, and whether it has expired.
  const claims = b64urlJson(p);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error('wrong issuer');
  if (claims.aud && claims.aud !== 'authenticated' &&
      !(Array.isArray(claims.aud) && claims.aud.includes('authenticated'))) throw new Error('wrong audience');
  if (!claims.sub) throw new Error('no subject');
  if (typeof claims.exp === 'number' && claims.exp <= now) throw new Error('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new Error('token not valid yet');

  const meta = claims.user_metadata || {};
  return {
    id: claims.sub,
    email: claims.email || null,
    name: meta.full_name || meta.name || (claims.email ? String(claims.email).split('@')[0] : null),
    // An anonymous TWEN session is a real account, but not a person who chose a
    // name — a game may want to hold off attaching lasting stats to it.
    anonymous: claims.is_anonymous === true,
  };
}

/** Express helper: reads `Authorization: Bearer …`, returns the identity or null. */
async function identityFromRequest(req) {
  const raw = String(req.headers.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { return await verifyTwenToken(m[1]); }
  catch (e) { return null; }
}

module.exports = { verifyTwenToken, identityFromRequest, JWKS_URL, ISSUER };
