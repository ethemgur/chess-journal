# Chess Review

An Obsidian plugin for one serious player reviewing their own games. Every finished game from Lichess, chess.com and over-the-board PGN files lands in your vault as **one reviewable note**: the full PGN with clock times, an interactive board you can annotate, and comparable offline Stockfish analysis.

Compatible with chess.com and Lichess. Not affiliated with either.

## What it does

- **Sync** your finished games from Lichess and chess.com (incremental, safe to re-run), and **import PGN files** for OTB games.
- **One note per game** with flat frontmatter (`my-result`, `opening`, `my-blunders`, …) that Dataview and Bases can query.
- **Board viewer and editor** in a `chess-game` code block: variations, comments, move and position symbols, arrows and highlights, clocks and time spent per move. Edits are written back as standard PGN.
- **Offline analysis** with Stockfish 18 (lite, single-threaded WebAssembly) in a background queue, an eval graph, and mistake marks based on the drop in winning chances.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Chess Review** and enter your Lichess and/or chess.com username. For chess.com, also enter a contact email; chess.com asks API clients to identify themselves.
3. Run **Sync all games** from the command palette or the ribbon menu.
4. The first analysis asks to download the engine (about 7.3 MB, once). You can also run **Download engine** yourself.

Games are written to `Chess/Games` by default. The first sync imports the last 12 months of rapid, classical and daily rated games; change this in the settings.

## The game note

````markdown
---
cr-schema: 1
game-key: "lichess:abcd1234"
site: lichess
my-result: win
analysis-status: done
my-blunders: 0
tags:
  - chess-game
reviewed: false
---
# ethem vs opponent123, 2026-10-04

<!-- chess-review:summary:start -->
Rapid 10+5 · Lichess · 1-0 by resignation · [open game](https://lichess.org/abcd1234)
My mistakes: 3 inaccuracies, 1 mistake, 0 blunders · ACPL 31
<!-- chess-review:summary:end -->

```chess-game
[Event "Rated rapid game"]
…full PGN…
```

## My review
````

What the plugin will and won't touch:

- It only rewrites its own frontmatter keys and the text between the `chess-review:summary` markers.
- The `chess-game` block is only changed by you, through the board editor. Sync never overwrites a game's PGN.
- `reviewed`, your own tags and everything else in the note belong to you.
- If you delete a game note, sync won't re-create it. You can clear the list of deleted games in the settings.
- Engine results are stored separately (in the plugin folder) and drawn as their own layer. They never become PGN annotations.

### Frontmatter keys (schema 1)

`cr-schema`, `game-key`, `site`, `url`, `played-at`, `date`, `white`, `black`, `my-colour`, `my-rating`, `opp-rating`, `result`, `my-result`, `termination`, `time-control`, `time-class`, `rated`, `eco`, `opening`, `event`, `round`, `site-accuracy`, `analysis-status`, `engine`, `my-acpl`, `my-inaccuracies`, `my-mistakes`, `my-blunders`, `opp-mistakes`, `opp-blunders`, `tags` (shared), `reviewed` (yours).

Example Dataview query:

````markdown
```dataview
TABLE opening, my-result, my-blunders
FROM #chess-game
WHERE time-class = "rapid" AND !reviewed
SORT played-at DESC
```
````

## Using the board

| Action | How |
| --- | --- |
| Move through the game | ← → , Home / End, or click a move. On mobile, use the buttons. |
| Choose a variation at a branch | ↑ ↓ |
| Flip the board | F |
| Add a move or variation | Play it on the board |
| Comment, symbols, promote, make main line, delete | Right-click a move (long-press on mobile) |
| Arrows and circles | Right-drag on the board. No modifier = green, Shift = red, Alt = blue, Shift+Alt = yellow |
| Undo / redo | Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z |
| Engine lines for this position | **Engine** button (up to 3 lines). **+** adds a line to the game as a variation. |

Keys only apply to the board that has focus. The plugin sets no default hotkeys.

## Analysis

- Each game's main line is analysed once with a fixed setting (1.5 s per position by default), so mistake counts are comparable across sites and months. The setting used is stored in each game's `engine` key.
- The opening uses Lichess cloud eval: up to 20 plies, stopping at the first position the cloud doesn't have.
- **Mistake marks** use the drop in winning chances, the same model Lichess uses. Inaccuracy ≥ 0.10, mistake ≥ 0.20, blunder ≥ 0.30 (on a −1…+1 scale). The engine's best move is never marked, and throwing away a forced mate is at least a mistake.
- ACPL is shown for continuity only; it does not affect the marks.
- The queue survives restarts. Pause, resume or cancel it from the command palette or the status bar.
- On mobile, analysis is off unless you turn on **Analyse on mobile**, and it pauses while the app is in the background.

## Commands

Sync all games · Sync Lichess games · Sync chess.com games · Cancel sync · Import PGN file · Analyse this game · Analyse all unanalysed games · Re-analyse with current settings · Pause / resume analysis · Cancel analysis · Open game on site · Copy PGN · Download engine

## Network use and privacy

All requests go through Obsidian's `requestUrl`, one at a time. There is no telemetry.

| Host | Why |
| --- | --- |
| `lichess.org` | Export your finished games (`/api/games/user/…`), and cloud evaluations for opening positions (`/api/cloud-eval`). If you set a Lichess token, it is sent only to lichess.org. |
| `api.chess.com` | Read your finished games from the public archives (`/pub/player/…/games/…`). Requests carry a User-Agent with your chess.com username and the contact email you entered. |
| `github.com` (release downloads) | Download the Stockfish engine files once, from the GitHub release of the installed plugin version. They are checked against SHA-256 hashes built into the plugin. |

Usernames and tokens are stored only in the plugin's `data.json`. They are never written into notes or logs.

## Fair play

The plugin only reads **finished** games through documented public APIs. It never fetches or analyses a game in progress: sync asks for finished games only, and the analysis queue refuses any game without a final result.

## Licences

- This plugin: GPL-3.0-or-later (see `LICENSE`).
- [chessops](https://github.com/niklasf/chessops) and [chessground](https://github.com/lichess-org/chessground) by the Lichess team: GPL-3.0.
- [Stockfish](https://stockfishchess.org/) 18 via [Stockfish.js](https://github.com/nmrugg/stockfish.js): GPL-3.0. Downloaded on first use, not bundled.
- The cburnett piece set, bundled with chessground, by Colin M.L. Burnett: GPLv2+.

## Development

```bash
npm install
npm run dev      # watch build into main.js / styles.css
npm test         # vitest unit tests (PGN round trip, sync, classification, queue, notes)
npm run lint
npm run build
```

Source layout:

```text
src/
  main.ts              plugin entry: commands, status bar, sync orchestration
  settings.ts          settings tab + defaults
  sources/             Lichess, chess.com and PGN-file clients; normalise.ts -> GameRecord
  sync/syncEngine.ts   incremental sync, de-duplication, cursors, 429 handling
  notes/               note rendering, frontmatter schema, managed regions
  pgn/tree.ts          chessops wrapper: parse, navigate, edit, serialise
  board/               BoardView (chessground + move list + eval graph) and the code block
  engine/              Stockfish worker, queue, cloud eval, classification, cache
tests/                 vitest tests and PGN fixtures
```

### Releasing

- `npm version patch|minor|major` bumps `manifest.json` and `versions.json`. Push, then run the **Release** workflow (or push a tag). It publishes a release named after the manifest version with `main.js`, `manifest.json` and `styles.css` (what BRAT and the community store install).
- Each release also carries `stockfish-18-lite-single.js` and `.wasm` (from the `stockfish@18.0.8` npm package, hash-checked against `src/engine/engineFiles.ts`). The plugin downloads them from its own version's release.
