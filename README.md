# Chess Journal

An Obsidian plugin for one serious player reviewing their own games. Every finished game from Lichess, chess.com and over-the-board PGN files lands in your vault as **one reviewable note**: the full PGN with clock times, an interactive board you can annotate, and comparable offline Stockfish analysis.

Compatible with chess.com and Lichess. Not affiliated with either.

## What it does

- **Sync** your finished games from Lichess and chess.com (incremental, safe to re-run), and **import PGN files** for OTB games.
- **One note per game** with flat frontmatter (`my-result`, `opening`, `my-blunders`, …) that Dataview and Bases can query.
- **Board viewer and editor** in a `chess-game` code block: variations, comments, move and position symbols, arrows and highlights, clocks and time spent per move. Edits are written back as standard PGN.
- **Offline analysis** with Stockfish 18 (lite, single-threaded WebAssembly) in a background queue, an eval graph, and mistake marks based on the drop in winning chances.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Chess Journal** and enter your Lichess and/or chess.com username. For chess.com, also enter a contact email; chess.com asks API clients to identify themselves.
3. Run **Sync all games** from the command palette or the ribbon menu.
4. Optional: the board's engine (and the analysis queue, off by default) asks to download Stockfish the first time you use it (about 7.3 MB, once). The dashboard does not need it.

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

<!-- chess-journal:summary:start -->
Rapid 10+5 · Lichess · 1-0 by resignation · [open game](https://lichess.org/abcd1234)
My mistakes: 3 inaccuracies, 1 mistake, 0 blunders · ACPL 31
<!-- chess-journal:summary:end -->

```chess-game
[Event "Rated rapid game"]
…full PGN…
```

## My review
````

What the plugin will and won't touch:

- It only rewrites its own frontmatter keys and the text between the `chess-journal:summary` markers.
- The `chess-game` block is only changed by you, through the board editor. Sync never overwrites a game's PGN.
- `reviewed`, your own tags and everything else in the note belong to you.
- If you delete a game note, sync won't re-create it. You can clear the list of deleted games in the settings.
- Engine results are stored separately (in the plugin folder) and drawn as their own layer. They never become PGN annotations.

### Frontmatter keys (schema 1)

`cr-schema`, `game-key`, `site`, `url`, `played-at`, `date`, `white`, `black`, `my-colour`, `my-rating`, `opp-rating`, `result`, `my-result`, `termination`, `time-control`, `time-class`, `rated`, `eco`, `opening`, `event`, `round`, `site-accuracy`, `opp-accuracy`, `time-trouble`, `first-10-seconds`, `opp-time-trouble`, `clock-curve`, `opp-clock-curve`, `longest-think`, `longest-think-move`, `moves`, `material-low`, `material-high`, `material-end`, `imbalances`, `endgame`, `analysis-status`, `engine`, `my-acpl`, `my-inaccuracies`, `my-mistakes`, `my-blunders`, `opp-mistakes`, `opp-blunders`, `tags` (shared), `reviewed` (yours).

`time-control` is written as the sites show it: minutes + increment in seconds (`3+2`, `10+5`, `½+0`), or `3 days` for daily games. The game's PGN keeps its original `TimeControl` tag in seconds. `time-class` is the site's own label (bullet, blitz, rapid, classical, daily).

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

Your edits (moves, comments, symbols, arrows and circles) are written into the note's `chess-game` block when you leave the board: when you tap or click anywhere outside it, switch or close the note, or Obsidian goes to the background. Saving while you work would make Obsidian redraw the block on every change.

## On-device analysis (optional)

Off by default: the dashboard uses the sites' accuracy instead. Turn on **Analyse new games automatically** (or run **Analyse this game**) if you want Stockfish to analyse games on your device.

- Each game's main line is analysed once with a fixed setting (1.5 s per position by default), so mistake counts are comparable across sites and months. The setting used is stored in each game's `engine` key.
- The opening uses Lichess cloud eval: up to 20 plies, stopping at the first position the cloud doesn't have.
- **Mistake marks** use the drop in winning chances, the same model Lichess uses. Inaccuracy ≥ 0.10, mistake ≥ 0.20, blunder ≥ 0.30 (on a −1…+1 scale). The engine's best move is never marked, and throwing away a forced mate is at least a mistake.
- ACPL is shown for continuity only; it does not affect the marks.
- The queue survives restarts. Pause, resume or cancel it from the command palette or the status bar.
- On mobile, analysis is off unless you turn on **Analyse on mobile**, and it pauses while the app is in the background.

## Performance dashboard

**Open performance dashboard** (command palette or ribbon menu) opens a view built from your game notes. It uses only what Lichess and chess.com provide (results, ratings, clock times and the sites' own accuracy figures) plus piece counts from the moves. No game is evaluated by an engine on your device, so it works the same on a phone.

- **Rating history:** one point per day per site and time class (the rating before that day's last game).
- **Rating cards:** live ratings from Lichess and chess.com per time class, never merged across sites, with the change over the period. Offline, the latest rating from your notes is shown, marked "from games".
- **Stat cards:** score, score vs expected (from pre-game ratings), performance rating (per site and time class), accuracy, accuracy vs your opponents in the same games, and time trouble. Each compares with the previous period of the same length.
- **Panels:** rating history · against stronger and weaker · openings (score, vs expected, accuracy) · comebacks and collapses · material imbalances · endgames · accuracy by result · accuracy by time control · time management · clock race · review queue.

**Clock statistics** come from the `%clk` times in the PGN (live online games; daily games have none):

- **Time management:** how often you and your opponents got into time trouble (clock below 10% of base time or 30 s), your score when only you, only they, both or neither did, time on your first 10 moves, losses on time (and how many of those you were not behind on material), wins on time, and your median longest think.
- **Clock race:** median clock left after moves 10, 20, 30 and 40 for you and your opponents (as % of base time), and your score when you had at least 10 points more time, about the same, or less at move 20.

**Material statistics** come from counting the pieces after every move (pawn 1, knight and bishop 3, rook 5, queen 9); a state counts when it lasts three moves or more, so the middle of an exchange is ignored.

- **Comebacks and collapses:** games where you were down at least 3 points and still won or drew ("turned around"), and games where you were up at least 3 points and drew or lost ("let slip"). Sacrifices count too, and a position can be lost without being down material, so these are a lower bound rather than an engine verdict.
- **Material imbalances**, named from your side: up or down the exchange, rook vs two minors, queen vs pieces, piece vs pawns, bishop pair (yours or theirs), opposite-coloured bishops. Score and score vs expected for each.
- **Endgames:** games that reached six or fewer pieces (kings and pawns not counted), and your score in them and in games decided before.

Notes from earlier versions get these keys (and the clock keys below) from their own `chess-game` block in the background shortly after Obsidian starts. **Update move statistics for all games** re-reads every note, for example after you changed a main line in the board editor.

**Accuracy comes from the sites:** Lichess gives it for games analysed on Lichess, chess.com for games with a Game Review. Lichess and chess.com measure accuracy on different scales, so accuracy figures always use one site at a time ("Accuracy from" in the filter bar) and are never averaged across sites. The review queue ranks unreviewed games by how much less accurate you were than your opponent in the same game, +0.5 if you lost; **Mark reviewed** sets `reviewed: true` in that note, the dashboard's only write.

Accuracy that a site adds later (for example after you request an analysis on Lichess) arrives with **Refresh accuracy and site data for all games**, which downloads your games again and updates only these site-owned keys.

## Commands

Open performance dashboard · Refresh accuracy and site data for all games · Update move statistics for all games · Sync all games · Sync Lichess games · Sync chess.com games · Cancel sync · Import PGN file · Analyse this game · Analyse all unanalysed games · Re-analyse with current settings · Pause / resume analysis · Cancel analysis · Open game on site · Copy PGN · Download engine

## Network use and privacy

All requests go through Obsidian's `requestUrl`, one at a time. There is no telemetry.

| Host | Why |
| --- | --- |
| `lichess.org` | Export your finished games (`/api/games/user/…`), cloud evaluations for opening positions (`/api/cloud-eval`), and your current ratings for the dashboard (`/api/user/…`, cached for 5 minutes). If you set a Lichess token, it is sent only to lichess.org. |
| `api.chess.com` | Read your finished games from the public archives (`/pub/player/…/games/…`), and your current ratings for the dashboard (`/pub/player/…/stats`, cached for an hour). Requests carry a User-Agent with your chess.com username and the contact email you entered. |
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
