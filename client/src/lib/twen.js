/* TWEN ID on the phone.
 *
 * twen.lol/auth.js is fetched at runtime — never bundled — because it is the one
 * copy shared by every TWEN game: a fix there reaches all of them without a
 * rebuild. Nothing here is allowed to be load-bearing. If the script never
 * arrives (no signal in the room, a blocker, a dev box), `ready()` resolves
 * false, the TWEN button hides itself, and Wilderdash's own username + PIN and
 * Guest paths carry on exactly as before.
 *
 * The handshake: TWEN gives us an access token, our server verifies it against
 * Supabase's published keys and hands back a normal Wilderdash token. The phone
 * never decides who anyone is.
 */

const SRC = 'https://twen.lol/auth.js';

let booted = null;

function isDevHost() {
  return /^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(location.hostname);
}

/** Resolves true when window.twen is usable. Never rejects. */
export function ready() {
  if (booted) return booted;
  booted = new Promise((resolve) => {
    if (window.twen) return window.twen.ready.then(() => resolve(true), () => resolve(false));
    // A dev box must not reach for the shared account store; tests inject their
    // own window.twen, which the check above picks up.
    if (isDevHost() && !window.__twenForce) return resolve(false);

    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => {
      if (!window.twen) return resolve(false);
      window.twen.ready.then(() => resolve(true), () => resolve(false));
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    setTimeout(() => resolve(!!window.twen), 6000);   // slow network: stop waiting
  });
  return booted;
}

/** The signed-in TWEN person, or null. Anonymous sessions count as null here:
 *  a profile should not be created for someone who has not chosen an account. */
export function twenUser() {
  const u = window.twen && window.twen.user();
  return u && !u.anonymous ? u : null;
}

/** Start Google sign-in. In the TWEN hub's iframe auth.js opens a popup; on a
 *  normal page it redirects. Either way, resolve once a real person is there. */
export async function twenSignIn() {
  if (!(await ready())) throw new Error('TWEN sign-in is unavailable right now.');
  if (twenUser()) return twenUser();

  window.twen.signIn();

  // The popup writes the shared session cookie; watch for it rather than
  // demanding a reload of a phone someone is holding mid-game.
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const stop = window.twen.onChange(() => {});   // keep the subscription alive
    const timer = setInterval(() => {
      const u = twenUser();
      if (u) { clearInterval(timer); resolve(u); return; }
      if (Date.now() - started > 180000) {
        clearInterval(timer);
        reject(new Error('Sign-in timed out.'));
      }
    }, 700);
    void stop;
  });
}

/** The current TWEN access token, for handing to our own server. */
export async function twenAccessToken() {
  if (!(await ready())) return null;
  const s = window.twen.session ? await window.twen.session() : null;
  if (s && s.access_token) return s.access_token;
  // auth.js keeps the session in a cookie on .twen.lol (or localStorage off it);
  // read it directly rather than adding an API surface for one field.
  const raw = readSessionRaw();
  return raw && raw.access_token ? raw.access_token : null;
}

function readSessionRaw() {
  const KEY = 'twen-auth';
  try {
    const fromCookie = (document.cookie || '').split('; ')
      .find((c) => c.startsWith(KEY + '='));
    if (fromCookie) return JSON.parse(decodeURIComponent(fromCookie.slice(KEY.length + 1)));
    const ls = localStorage.getItem(KEY);
    if (ls) return JSON.parse(ls);
  } catch (e) { /* unreadable is the same as absent */ }
  return null;
}
