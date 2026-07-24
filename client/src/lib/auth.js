// Phone-side account state. A signed-in player has { token, user } persisted
// in localStorage; guests have nothing here and the rest of the app behaves
// exactly as before. The token is sent on player:join so the server links
// game results to the profile.

const KEY = 'cperkd_auth';
const subs = new Set();

let cache = (() => {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    return j && j.token && j.user ? j : null;
  } catch (e) { return null; }
})();

function emit() { subs.forEach((fn) => { try { fn(cache); } catch (e) {} }); }

function set(v) {
  cache = v;
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch (e) {}
  emit();
}

export function getAuth() { return cache; }
export function getToken() { return cache && cache.token ? cache.token : null; }
export function isSignedIn() { return !!getToken(); }
export function subscribeAuth(fn) { subs.add(fn); return () => subs.delete(fn); }
export function signOut() { set(null); }

async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: JSON.stringify(body || {})
  });
  let d;
  try { d = await res.json(); } catch (e) { d = { ok: false, error: 'Server error' }; }
  if (!res.ok || !d || !d.ok) throw new Error((d && d.error) || 'Something went wrong');
  return d;
}

export async function signup(username, pin, avatar) {
  const d = await postJson('/api/auth/signup', { username, pin, avatar });
  set({ token: d.token, user: d.user });
  return d.user;
}

export async function login(username, pin) {
  const d = await postJson('/api/auth/login', { username, pin });
  set({ token: d.token, user: d.user });
  return d.user;
}

// Re-fetch the profile (refreshed stats / validate the stored token). Clears
// auth on a 401 so a stale token doesn't strand the UI in a signed-in state.
export async function refreshMe() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { set(null); return null; }
    const d = await res.json();
    if (d && d.ok) { set({ token, user: d.user }); return d.user; }
  } catch (e) {}
  return cache ? cache.user : null;
}

// Persist a freshly chosen avatar to the profile (best-effort).
export async function saveAvatar(avatar) {
  const token = getToken();
  if (!token || !avatar) return;
  try {
    const d = await postJson('/api/auth/avatar', { avatar }, token);
    set({ token, user: d.user });
  } catch (e) {}
}
