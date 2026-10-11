/**
 * Every dashboard term from the Performance Dashboard spec, implemented once.
 * Pure functions and named constants only; unit-tested in tests/definitions.test.ts.
 */

export type Phase = "opening" | "middlegame" | "endgame";
export const PHASES: Phase[] = ["opening", "middlegame", "endgame"];

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Opening = plies 1–24, unless the endgame starts earlier. */
export const OPENING_LAST_PLY = 24;
/** Endgame starts at the first ply where both sides' non-pawn material totals this or less. */
export const ENDGAME_MATERIAL = 26;
export const PIECE_VALUES = { queen: 9, rook: 5, bishop: 3, knight: 3 } as const;
/** Winning/losing: my eval at ±this after two consecutive moves of mine (setting, default 200). */
export const DEFAULT_WINNING_CP = 200;
/** Time trouble: clock below the larger of this share of base time, or TIME_TROUBLE_MIN_SEC. */
export const TIME_TROUBLE_SHARE = 0.1;
export const TIME_TROUBLE_MIN_SEC = 30;
/** Weakest phase needs at least this many of my moves in the phase. */
export const WEAKEST_PHASE_MIN_MOVES = 20;
/** Performance rating cap (± from average opponent rating). */
export const PERFORMANCE_CAP = 800;
/** Evals are clamped to ±1000 cp from my side for peak/low figures. */
export const EVAL_CLAMP_CP = 1000;
/** Rolling window for the trend panel. */
export const TREND_WINDOW = 20;
/** Review priority weights. */
export const PRIORITY_LOST = 0.5;
export const PRIORITY_NOT_CONVERTED = 0.25;

/* ------------------------------------------------------------------ */
/* Score, expected score, performance                                  */
/* ------------------------------------------------------------------ */

export type MyResult = "win" | "draw" | "loss";

/** Win 1, draw ½, loss 0. */
export function points(r: MyResult): number {
	return r === "win" ? 1 : r === "draw" ? 0.5 : 0;
}

/** E = 1 / (1 + 10^((opp − my) / 400)), pre-game ratings from the same site. */
export function expectedScore(myRating: number, oppRating: number): number {
	return 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
}

/** FIDE rating difference for a score fraction p (table 8.1.2), for p = 0.50 … 1.00. */
const FIDE_DP: number[] = [
	0, 7, 14, 21, 29, 36, 43, 50, 57, 65, 72, 80, 87, 95, 102, 110, 117, 125, 133, 141, 149, 158, 166, 175, 184, 193,
	202, 211, 220, 230, 240, 251, 262, 273, 284, 296, 309, 322, 336, 351, 366, 383, 401, 422, 444, 470, 501, 538, 589,
	677, 800,
];

/** FIDE dp for a score fraction (0…1), symmetric around 0.5. */
export function fideDp(p: number): number {
	const q = Math.round(Math.max(0, Math.min(1, p)) * 100) / 100;
	const i = Math.round(Math.abs(q - 0.5) * 100);
	const dp = FIDE_DP[Math.min(i, 50)];
	return q >= 0.5 ? dp : -dp;
}

/** Average opponent rating + FIDE dp for the score fraction, capped at ±800. Use per site and time class only. */
export function performanceRating(oppRatings: number[], scorePoints: number): number | undefined {
	if (!oppRatings.length) return undefined;
	const avg = oppRatings.reduce((a, b) => a + b, 0) / oppRatings.length;
	const dp = Math.max(-PERFORMANCE_CAP, Math.min(PERFORMANCE_CAP, fideDp(scorePoints / oppRatings.length)));
	return Math.round(avg + dp);
}

/* ------------------------------------------------------------------ */
/* Rating bands                                                         */
/* ------------------------------------------------------------------ */

export type Band = "much-weaker" | "weaker" | "equal" | "stronger" | "much-stronger";
export const BANDS: Band[] = ["much-weaker", "weaker", "equal", "stronger", "much-stronger"];
export const BAND_LABEL: Record<Band, string> = {
	"much-weaker": "≤ −200",
	weaker: "−199 to −50",
	equal: "−49 to +49",
	stronger: "+50 to +199",
	"much-stronger": "≥ +200",
};

/** Band by opponent − me. */
export function ratingBand(myRating: number, oppRating: number): Band {
	const d = oppRating - myRating;
	if (d <= -200) return "much-weaker";
	if (d <= -50) return "weaker";
	if (d < 50) return "equal";
	if (d < 200) return "stronger";
	return "much-stronger";
}

/* ------------------------------------------------------------------ */
/* Phases                                                               */
/* ------------------------------------------------------------------ */

export interface Material {
	white: number;
	black: number;
}

/** Non-pawn material of one side from piece counts. */
export function nonPawnMaterial(counts: { queen: number; rook: number; bishop: number; knight: number }): number {
	return counts.queen * PIECE_VALUES.queen + counts.rook * PIECE_VALUES.rook + counts.bishop * PIECE_VALUES.bishop + counts.knight * PIECE_VALUES.knight;
}

/**
 * First ply at which the endgame starts: both sides' non-pawn material totals 26 or less.
 * `material[i]` is the material after ply i (index 0 = start). Returns undefined if never.
 */
export function endgameStartPly(material: Material[]): number | undefined {
	for (let i = 0; i < material.length; i++) {
		if (material[i].white + material[i].black <= ENDGAME_MATERIAL) return i;
	}
	return undefined;
}

/** Phase of the move that produced ply `ply` (1-based). */
export function phaseOfPly(ply: number, endgameStart: number | undefined): Phase {
	if (endgameStart !== undefined && ply >= endgameStart) return "endgame";
	if (ply <= OPENING_LAST_PLY) return "opening";
	return "middlegame";
}

/* ------------------------------------------------------------------ */
/* Errors, winning/losing, time trouble                                */
/* ------------------------------------------------------------------ */

export type MarkKind = "inaccuracy" | "mistake" | "blunder";

/** An error is a mistake or blunder; inaccuracies are excluded. */
export const isError = (k: MarkKind) => k === "mistake" || k === "blunder";

/** Errors per 10 moves. */
export function errorRate(errors: number, moves: number): number | undefined {
	return moves > 0 ? (errors / moves) * 10 : undefined;
}

/**
 * Winning: my eval ≥ +threshold after two consecutive moves of mine; losing: ≤ −threshold.
 * `evalsAfterMyMoves` are my-side centipawns after each of my moves, in order.
 */
export function reachedWinningLosing(evalsAfterMyMoves: number[], threshold = DEFAULT_WINNING_CP): { winning: boolean; losing: boolean } {
	let winning = false;
	let losing = false;
	for (let i = 1; i < evalsAfterMyMoves.length; i++) {
		const a = evalsAfterMyMoves[i - 1];
		const b = evalsAfterMyMoves[i];
		if (a >= threshold && b >= threshold) winning = true;
		if (a <= -threshold && b <= -threshold) losing = true;
	}
	return { winning, losing };
}

/** Clock level (seconds) below which I am in time trouble. */
export function timeTroubleThreshold(baseSec: number): number {
	return Math.max(TIME_TROUBLE_SHARE * baseSec, TIME_TROUBLE_MIN_SEC);
}

/** Time trouble: my clock after any of my moves below the threshold. Null without clocks or for daily games. */
export function inTimeTrouble(myClocksAfterMove: number[], baseSec: number | undefined, daily: boolean): boolean | null {
	if (daily || baseSec === undefined || !myClocksAfterMove.length) return null;
	const t = timeTroubleThreshold(baseSec);
	return myClocksAfterMove.some((c) => c < t);
}

/* ------------------------------------------------------------------ */
/* Conversion, saves, openings, review priority                        */
/* ------------------------------------------------------------------ */

/** Score % (0–1) in a set of games. */
export function scoreFraction(results: MyResult[]): number | undefined {
	return results.length ? results.reduce((a, r) => a + points(r), 0) / results.length : undefined;
}

/** Sum over games that reached winning of (1 − my score). */
export function pointsThrownAway(games: Array<{ reachedWinning: boolean; result: MyResult }>): number {
	return games.filter((g) => g.reachedWinning).reduce((a, g) => a + (1 - points(g.result)), 0);
}

/** Opening name up to the first colon; ECO code if there is no name. */
export function openingFamily(opening?: string, eco?: string): string {
	const name = (opening ?? "").trim();
	if (name) return name.split(":")[0].trim();
	return (eco ?? "").trim() || "Unknown";
}

export function median(xs: number[]): number | undefined {
	if (!xs.length) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Biggest swing ΔW (0–2) + 0.5 if lost + 0.25 if a winning position was not won. */
export function reviewPriority(biggestSwingDeltaW: number, result: MyResult, reachedWinning: boolean): number {
	let p = Math.max(0, Math.min(2, biggestSwingDeltaW));
	if (result === "loss") p += PRIORITY_LOST;
	if (reachedWinning && result !== "win") p += PRIORITY_NOT_CONVERTED;
	return p;
}
