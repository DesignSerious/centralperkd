# Central Perk'd — Friends Trivia Game

A phone-controlled TV party game. Up to 8 players join from their phones,
answer Friends trivia, and race their pieces around a board on the TV from
START to FINISH. First piece home wins.

Sibling project to **Wilderdash** — same architecture, same reusable systems
(pieces, AI piece generation, accounts, music, board renderer). Only the game
itself is different.

## Run it

```bash
npm install
npm run dev          # Express on :3000 + Vite on :5173
```

Open the **TV** at <http://localhost:5173/tv> and **phones** at
`http://<your-lan-ip>:5173/join`. The TV shows a 4-letter room code; phones
type it in, pick a name and a piece, and you're in. Two players minimum.

Production build (what Railway runs):

```bash
npm run build && npm start   # single process on :3000, serves /tv and /join
```

### Testing solo

Two ways, no extra phones needed:

- **Watch a whole game** — open the TV at `/tv?dev` and hit
  **Simulate a game (dev)** on an empty lobby. Four CPU players drop in and
  play a 20-space board on fast timings; the loop finishes in about a minute.
- **Play against CPUs** — join from one phone and use the lobby's
  **CPU players** stepper to add up to 4 bots, then start normally.

There's also an automated end-to-end test covering a live 3-phone round and a
full bot game:

```bash
node server/index.js                              # terminal 1
BASE=http://localhost:3000 node scripts/smoke-test.js   # terminal 2
```

It checks the phase order, that answers stay private until the reveal, the
speed-ranking math, the movement, and that a bot game reaches GAME_OVER with
a winner on the finish line.

## How a round works

```
LOBBY → ROUND_INTRO → QUESTION → ANSWERING → REVEAL → MOVEMENT → (win?) → …
                                                                    ↓
                                                                GAME_OVER
```

- **ROUND_INTRO** — round number + the category coming up (and any duel).
- **QUESTION** — the question goes up on the TV with phones still locked, so
  the whole room reads it at the same time. This beat is what makes the speed
  bonus fair rather than a reading-speed contest.
- **ANSWERING** — phones unlock. Answers are final and private. The clock is
  server-enforced; the phase ends early once everyone has locked in.
- **REVEAL** — the answer, who got it, how fast, and what that earns.
- **MOVEMENT** — the results card holds while pieces are frozen, then fades
  and the pieces walk the board one at a time.

**Movement** (constants at the top of `server/game.js`):

| Result                  | Spaces |
| ----------------------- | ------ |
| Fastest correct answer  | +3     |
| Correct, in the middle  | +2     |
| Slowest correct answer  | +1     |
| Wrong / no answer       | 0      |

Plus `CATEGORY_BONUS` (+1) and `DUEL_BONUS` (+2) from board spaces.

## Architecture

Single Node process: Express serves the built Vite client and runs the
Socket.io game server. Multi-page Vite build — `tv.html` at `/tv`,
`phone.html` at `/join`, `playlist.html` at `/playlist`. React 18, no
TypeScript, Node 24, deployed on Railway.

**The server is authoritative.** All rooms live in memory in `server/game.js`.
Clients emit actions and render the snapshots the server broadcasts; they never
decide a transition, never see another player's answer before REVEAL, and never
compute movement. Snapshots are role-shaped: the TV gets one view, each phone
gets its own private view.

```
server/index.js      Express + Socket.io, room lifecycle, AI piece endpoints,
                     accounts API, playlist admin API
server/game.js       The state machine: rooms, players, phases, timers,
                     answer ranking, movement, bots
server/board.js      Board layout — space types, scaled to the chosen length
server/questions.js  Question bank loader + draw (no repeats, shuffled choices)
server/questions.json  ← the editable question bank
server/profiles.js   Player accounts (username + PIN, SQLite, HMAC tokens)

client/src/tv/       TV app; Board2D.jsx is the board renderer
client/src/phone/    Phone controller
client/src/lib/      Shared: pieces, AI generator, photo capture, sfx, music,
                     AutoFit, fullscreen, rules overlay, theme
```

## The question bank

`server/questions.json` is a plain array — edit it freely, the server validates
on load and skips (with a warning) anything malformed rather than crashing:

```json
{ "id": "q001", "category": "quotes", "difficulty": "easy",
  "question": "Who yells, \"We were on a break!\"?",
  "choices": ["Ross", "Rachel", "Joey", "Chandler"], "answerIndex": 0 }
```

Categories live in `server/board.js` (`CATEGORIES`) and are mirrored for the
lobby toggles in `client/src/tv/App.jsx` (`CATEGORY_OPTIONS`) — add a category
in both places. Choices are **shuffled on every draw**, so it doesn't matter
that the seeded bank always lists the answer first. No question repeats within
a game.

The 60 seeded questions are placeholders: real, but written to get the game
running. Replace and expand at will.

## The board

`server/board.js` authors the canonical 32-move layout — index 0 is START (the
doormat), 1..31 the numbered spaces, 32 FINISH (the couch). The 16- and
48-space boards are scaled from it, so board length is one lobby setting rather
than three hand-maintained maps. Space types:

- `normal`
- `bonus` — the coffee-cup tile: your next correct answer pays double
- `advance` — an arrow painted along the direction of travel; moves you
  `steps` further on (blue arrow 1, purple arrows 2). Relative steps, not a
  jump to a fixed square.
- `duel` — pairs the lander against a rival for the next round; the higher
  scorer takes the duel bonus

Landing effects only fire on landing, never on passing, and an effect never
chains into a second one. **Nothing on this board moves a piece backwards** —
there is no setback tile, and losing a duel simply wins you nothing.

The special-tile indices in `CANONICAL_SPECIALS` are still placeholders: they
are spaced guesses so the game is playable, not the painted positions. Trace
the path with `/tv?calibrate`, then derive the real table from the artwork.

## Board art + the piece path

`client/src/tv/Board2D.jsx` holds `PATH`: one `{x, y}` percent coordinate per
space, traced over the board image. **It is still Wilderdash's path over
Wilderdash's board art** — placeholder until the real board lands.

To re-trace it for new art:

1. Drop the board image in `client/public/` and point `tv-board-bg` at it.
2. Open `/tv?calibrate` and click each space in order, START → FINISH.
3. Paste the printed array over `PATH`.
4. Open `/tv?adjust` to drag any space that needs nudging; the array updates
   live. `/tv?debug` just overlays the current path.

Pieces are anchored bottom-center on their coordinate, up to 8 per space get
packed automatically, and movement walks space-by-space along the path (never
a straight diagonal) with the slide sound fired in the same step.

## Placeholders to replace

- **Board art** — `client/public/board-no-logo.jpg` (Wilderdash's), plus `PATH`
- **Piece art** — `client/public/pieces/*.png` and the catalog in
  `client/src/lib/pieces.js`
- **Logo** — `client/public/logo.png`
- **Music** — none shipped. Drop mp3s in `client/public/audio/`, then sort them
  into vibes at `/playlist` (password: `PLAYLIST_PASSWORD`, default
  `centralperkd`). SFX in `client/public/audio/misc/` are already wired up.
- **AI piece base styling** — `BASE_RIM_COLOR` / `BASE_RIM_ICON` in
  `server/index.js` (currently deep purple + a gold coffee cup)

## Environment

Copy `.env.example` to `.env`. Everything is optional:

| Var | What it does |
| --- | --- |
| `OPENAI_API_KEY` | Enables "Generate a piece with AI". Without it the feature greys out cleanly. |
| `AUTH_SECRET` | Signs account tokens. Set in production or tokens reset on restart. |
| `FRIENDS_TRIVIA_DB` | Accounts SQLite path. Point at a persistent volume in prod. |
| `PLAYLIST_PASSWORD` | Password for the `/playlist` admin. |
| `PORT` | Defaults to 3000. |

## Deploy (Railway)

`railway.json` is set up: NIXPACKS, `npm run build`, `node server/index.js`,
health check on `/api/health`. Railway's filesystem is ephemeral across
deploys — mount a volume and point `FRIENDS_TRIVIA_DB` at it if accounts and
generated pieces need to survive redeploys.
