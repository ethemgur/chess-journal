# Chess Journal

An Obsidian plugin for one serious player reviewing their own games. Every finished game from Lichess and over-the-board PGN files lands in your vault as **one reviewable note**: the full PGN with clock times, an interactive board you can annotate, and computer analysis (Lichess's own for Lichess games, Stockfish on your device for OTB games).

Compatible with Lichess. Not affiliated with it.

## What it does

- **Sync** your finished games from Lichess (incremental, safe to re-run), and **import PGN files** for OTB games.
- **One note per game** with flat frontmatter (`my-result`, `opening`, `my-blunders`, …) that Dataview and Bases can query.
- **Board viewer and editor** in a `chess-game` code block: variations, comments, move and position symbols, arrows and highlights, clocks and time spent per move. Edits are written back as standard PGN.
- **Lichess analysis** for Lichess games: the counts, accuracy, evaluations and mistake marks Lichess computed. Games not analysed yet are marked "awaiting" and fill in on a later sync.
- **Offline analysis** for OTB games with Stockfish 18 (lite, single-threaded WebAssembly) in a background queue, an eval graph, and mistake marks based on the drop in winning chances.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Chess Journal**, enter your Lichess username (**Check** confirms it and shows your ratings), and pick the speeds to import.
3. Run **Sync Lichess games** from the command palette or the ribbon menu.
4. Optional: the board's engine (and the OTB analysis queue, off by default) asks to download Stockfish the first time you use it (about 7.3 MB, once). Lichess games and the dashboard do not need it.

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

`cr-schema`, `game-key`, `site`, `url`, `played-at`, `date`, `white`, `black`, `my-colour`, `my-rating`, `opp-rating`, `result`, `my-result`, `termination`, `time-control`, `time-class`, `rated`, `eco`, `opening`, `event`, `round`, `site-accuracy`, `opp-accuracy`, `time-trouble`, `first-10-seconds`, `opp-time-trouble`, `clock-curve`, `opp-clock-curve`, `longest-think`, `longest-think-move`, `moves`, `material-low`, `material-high`, `material-end`, `imbalances`, `endgame`, `analysis-status`, `engine`, `my-acpl`, `my-inaccuracies`, `my-mistakes`, `my-blunders`, `opp-mistakes`, `opp-blunders`, `my-errors-opening`, `my-errors-middlegame`, `my-errors-endgame`, `my-errors-low-clock`, `missed-chances`, `first-error-move`, `eval-high`, `eval-low`, `tags` (shared), `reviewed` (yours).

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

## Lichess analysis

Lichess games use the computer analysis Lichess made of them; nothing runs on your device.

- Lichess analyses a game when someone presses **Request a computer analysis** on its page. Its API cannot start one, so the plugin cannot either: **Analyse this game** on a Lichess game opens it on lichess.org for you.
- A game imported before it was analysed gets `analysis-status: awaiting`. Every sync asks Lichess again for all awaiting games (by ID, 300 per request), and fills the note in once the analysis exists: `analysis-status: done`, `engine: lichess`, your inaccuracies, mistakes, blunders and ACPL, your opponent's mistakes and blunders, and both accuracies.
- The board shows Lichess's evaluation for every move, its marks (hover a mark for Lichess's comment, such as "Mistake. Nf3 was best.") and its best line where it judged a move inaccurate.
- An analysis you already ran on this device is kept until Lichess's arrives.
- Changing the speeds, **Rated games only** or **Games since** re-reads your games from the start date on the next sync.

## On-device analysis for OTB games (optional)

Off by default. Turn on **Analyse imported games automatically** (under Over-the-board games) (or run **Analyse this game** on an OTB game) to have Stockfish analyse imported PGN games on your device.

- Each game's main line is analysed once with a fixed setting (1.5 s per position by default), so mistake counts are comparable across months. The setting used is stored in each game's `engine` key.
- The opening uses Lichess cloud eval: up to 20 plies, stopping at the first position the cloud doesn't have.
- **Mistake marks** use the drop in winning chances, the same model Lichess uses. Inaccuracy ≥ 0.10, mistake ≥ 0.20, blunder ≥ 0.30 (on a −1…+1 scale). The engine's best move is never marked, and throwing away a forced mate is at least a mistake.
- ACPL is shown for continuity only; it does not affect the marks.
- The queue survives restarts. Pause, resume or cancel it from the command palette or the status bar.
- On mobile, analysis is off unless you turn on **Analyse on mobile**, and it pauses while the app is in the background.

## Performance dashboard

**Open performance dashboard** (command palette or ribbon menu) opens a view built from your game notes. It uses what Lichess provides (results, ratings, clock times, accuracy and Lichess's computer analysis), piece counts from the moves, and the Stockfish analyses of your OTB games. Nothing is evaluated while the dashboard is open, so it works the same on a phone.

- **Rating history:** one point per day per time class (the rating before that day's last game).
- **Rating cards:** live Lichess ratings per time class, with the change over the period. Offline, the latest rating from your notes is shown, marked "from games".
- **Stat cards:** score, score vs expected (from pre-game ratings), performance rating (per site and time class), accuracy (and your opponents' in the same games), mistakes per game (with blunders and ACPL), and time trouble. Each compares with the previous period of the same length.
- **Panels:** rating history · mistake trend · where I make mistakes · against stronger and weaker · openings (score, vs expected, accuracy, mistakes per game) · converting and saving · material imbalances · endgames · accuracy by result · accuracy by time control · time management · clock race · review queue.

**Clock statistics** come from the `%clk` times in the PGN (live online games; daily games have none):

- **Time management:** how often you and your opponents got into time trouble (clock below 10% of base time or 30 s), your score when only you, only they, both or neither did, time on your first 10 moves, losses on time (and how many of those you were not behind on material), wins on time, and your median longest think.
- **Clock race:** median clock left after moves 10, 20, 30 and 40 for you and your opponents (as % of base time), and your score when you had at least 10 points more time, about the same, or less at move 20.

**Mistake statistics** come from the computer analysis: Lichess's for Lichess games, Stockfish's for OTB games. A mistake is Lichess's "Mistake" or "Blunder" (inaccuracies are counted separately). Each analysed note stores where its mistakes happened, and the dashboard adds them up:

- **Mistake trend:** mistakes and blunders per game, month by month.
- **Where I make mistakes:** mistakes per game (and your opponents'), the share made in time trouble (clock below 10% of base time or 30 s before the move), your opponents' mistakes you did not punish (your reply gave back at least half of what their mistake gave you), the move of your first mistake, games without a mistake, and mistakes per game in the opening, middlegame and endgame (Lichess's own phase split; Lichess games only).
- These figures only cover analysed games. Lichess analyses a game when you request it, so they may lean towards the games you chose to look at; every panel says how many of the games it covers.

**Material statistics** come from counting the pieces after every move (pawn 1, knight and bishop 3, rook 5, queen 9); a state counts when it lasts three moves or more, so the middle of an exchange is ignored.

- **Converting and saving:** how often you won when you were winning, and saved games when you were losing. Analysed games use the evaluation (at least 3 pawns for or against you for two moves or more); games without an analysis fall back to material (up or down at least 3 points for three moves or more).
- **Material imbalances**, named from your side: up or down the exchange, rook vs two minors, queen vs pieces, piece vs pawns, bishop pair (yours or theirs), opposite-coloured bishops. Score and score vs expected for each.
- **Endgames:** games that reached six or fewer pieces (kings and pawns not counted), and your score in them and in games decided before.

Notes from earlier versions get these keys (and the clock keys below) from their own `chess-game` block in the background shortly after Obsidian starts. **Update move statistics for all games** re-reads every note, for example after you changed a main line in the board editor.

**Accuracy comes from Lichess:** it exists for games analysed on Lichess. The review queue ranks unreviewed games by your blunders (1 each) and mistakes (½ each, up to 2), how much less accurate you were than your opponent (up to 1), +0.5 if you let a winning position go and +0.5 if you lost; **Mark reviewed** sets `reviewed: true` in that note, the dashboard's only write.

Accuracy and analysis that Lichess adds later arrive on the next sync for games marked "awaiting". **Refresh Lichess data for all games** (also **Re-read all** in the settings) downloads all your games again and updates only the Lichess-owned keys, for example after deleting notes you want back (clear **Deleted games** in the settings first).

## Commands

Open performance dashboard · Refresh Lichess data for all games · Update move statistics for all games · Sync Lichess games · Cancel sync · Import PGN file · Analyse this game · Analyse all unanalysed games · Re-analyse with current settings · Pause / resume analysis · Cancel analysis · Open game on site · Copy PGN · Download engine

## Network use and privacy

All requests go through Obsidian's `requestUrl`, one at a time. There is no telemetry.

| Host | Why |
| --- | --- |
| `lichess.org` | Export your finished games (`/api/games/user/…`), re-check games awaiting analysis (`POST /api/games/export/_ids`), cloud evaluations for opening positions (`/api/cloud-eval`), and your current ratings for the dashboard (`/api/user/…`, cached for 5 minutes). If you set a Lichess token, it is sent only to lichess.org. |
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
  sources/             Lichess and PGN-file clients; normalise.ts -> GameRecord; lichessAnalysis.ts
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
