// Shared admin auth for the /admin, /sounds and /playlist pages. All three use
// ONE key in localStorage, so signing into any of them signs you into all of
// them (localStorage is shared across tabs on the same origin, so a link that
// opens in a new tab stays signed in too). The password is validated against
// /api/playlist/login (the single operator password, PLAYLIST_PASSWORD).
export const ADMIN_PWD_KEY = 'cperkd_admin_auth';

export function loadAdminPwd() {
  try { return localStorage.getItem(ADMIN_PWD_KEY) || ''; } catch (e) { return ''; }
}
export function saveAdminPwd(p) {
  try { localStorage.setItem(ADMIN_PWD_KEY, p); } catch (e) {}
}
export function clearAdminPwd() {
  try { localStorage.removeItem(ADMIN_PWD_KEY); } catch (e) {}
}
export function verifyAdminPwd(password) {
  return fetch('/api/playlist/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  }).then((r) => r.json()).then((d) => !!(d && d.ok)).catch(() => false);
}
