# Deploying Central Perk'd to Railway

Central Perk'd is one Node process: an Express + Socket.io server that serves the
built Vite/React client. It's already configured for Railway via `railway.json`
(build `npm run build` → start `node server/index.js`, health check `/api/health`).

The goal here: get it live at a Railway URL (e.g. `https://centralperkd-production.up.railway.app`),
then point the TWEN "Central Perk'd" card at that URL so it slides up in the site.

---

## 1. Put the repo on GitHub (Railway deploys from a repo)

The folder is already a git repo with an initial commit. Create an empty GitHub
repo (e.g. `DesignSerious/centralperkd`, **private**), then from `D:\DesignSerious\centralperkd`:

```bash
git branch -M main
git remote add origin https://github.com/DesignSerious/centralperkd.git
git push -u origin main
```

(Or use the GitHub CLI: `gh repo create DesignSerious/centralperkd --private --source=. --push`.)

`.env`, `server/uploads/`, `server/data/`, `dist/`, and `node_modules/` are gitignored —
no secrets or build artifacts get pushed.

## 2. Create the Railway service

1. Railway → **New Project → Deploy from GitHub repo** → pick `centralperkd`.
2. Railway reads `railway.json` automatically:
   - Build: `npm run build` (Vite builds the client into `dist/`)
   - Start: `node server/index.js`
   - Health check: `/api/health`
3. Node version is pinned to 24.x by `package.json` (`engines.node`).

## 3. Environment variables (Railway → service → Variables)

Nothing is strictly required to *play* — but set these:

| Variable | Set it? | Why |
|---|---|---|
| `AUTH_SECRET` | **Recommended** | Signs player-account tokens. Without it a dev default is used and logins reset on every restart. Use a long random string. |
| `PLAYLIST_PASSWORD` | **Recommended** | Password for the `/admin`, `/sounds`, `/playlist` panels. Use your current one (`j0cklediLz**`) or a new one. Defaults to `centralperkd` if unset. |
| `OPENAI_API_KEY` | Optional | Enables "Generate a piece with AI". Without it, that one feature is disabled; everything else works. |
| `FRIENDS_TRIVIA_DB` | Optional | Point at a volume path (see below) to keep player accounts across redeploys. |
| `PORT` | **Don't set** | Railway injects this automatically; the server already reads `process.env.PORT`. |

Do **not** upload the local `.env` — set these in the Railway dashboard.

## 4. Generate the public URL

Railway → service → **Settings → Networking → Generate Domain**. You'll get a
`*.up.railway.app` URL. That's the address to play at, and the one the TWEN card
loads. (You can attach a custom domain later without changing anything else.)

## 5. Point TWEN at it

In `D:\DesignSerious\twen\index.html`, the Central Perk'd card's `href` is a
placeholder:

```html
<a class="card live" href="https://REPLACE-WITH-CENTRAL-PERKD-RAILWAY-URL" ...>
```

Replace that `href` with your Railway URL, then redeploy TWEN. Clicking the card
now slides Central Perk'd up in the site's iframe viewer. (Players still join on
their phones at `<your-railway-url>/join` with the room code shown on the board —
that URL is correct even when the board is shown inside the TWEN iframe.)

---

## Persistence note (optional, for later)

Gameplay needs no persistent storage. But content changed at runtime through the
admin panels resets on each redeploy unless you add a Railway **volume**:

- **Player accounts** — set `FRIENDS_TRIVIA_DB` to a path on a mounted volume
  (e.g. `/data/friends-trivia.db`). This one is env-configurable today.
- **Uploaded custom sounds, music, and AI pieces** — these currently write to
  fixed paths inside the app (`server/uploads/`, `client/public/audio/`), so they
  reset on redeploy. The committed defaults (built-in sounds, `sounds.json`,
  `playlist.json`, `game-settings.json`) always load, so the game is fully
  configured out of the box; only *new* runtime uploads are ephemeral. Persisting
  those would need a small code change to redirect their paths onto a volume —
  ask if you want that.
