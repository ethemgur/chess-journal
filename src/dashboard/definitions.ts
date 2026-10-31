/**
 * Every dashboard term, implemented once. The dashboard uses what Lichess provides
 * (results, ratings, clocks, accuracy and its computer analysis), piece counts from
 * the moves, and Stockfish analyses of OTB games. Unit-tested in tests/definitions.test.ts.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Time trouble: clock below the larger of this share of base time, or TIME_TROUBLE_MIN_SEC. */
export const TIME_TROUBLE_SHARE = 0.1;
export const TIME_TROUBLE_MIN_SEC = 30;
/** Clock checkpoints: time left after these moves (each side's own move count). */
export const CLOCK_CHECKPOINTS = [10, 20, 30, 40];
/** Clock race: at move CLOCK_EDGE_MOVE, one side has at least CLOCK_EDGE_PCT % of base time more. */
export const CLOCK_EDGE_MOVE = 20;
export const CLOCK_EDGE_PCT = 10;
/** Performance rating cap (± from average opponent rating). */
export const PERFORMANCE_CAP = 800;
/** Review priority: accuracy gap (opponent − me) per this many points counts 1; capped; plus a loss bonus. */
export const PRIORITY_GAP_UNIT = 10;
export const PRIORITY_GAP_CAP = 1;
export const PRIORITY_LOST = 0.5;
/** Review priority: blunders count 1 and mistakes ½, capped; a winning position not won adds this. */
export const PRIORITY_ERRORS_CAP = 2;
export const PRIORITY_THROWN = 0.5;
/** Winning / losing position: an evaluation of at least this many pawns, held for EVAL_LASTING_PLIES positions. */
export const WINNING_EVAL = 3;
export const EVAL_LASTING_PLIES = 4;
/** Evaluations are capped at ± this many pawns (mate counts as the cap). */
export const EVAL_CAP = 10;
/** A missed chance: my reply gives back at least this share of what my opponent's mistake gave me (winning chances). */
export const MISSED_GIVE_BACK = 0.5;

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
/* Time trouble                                                        */
/* ------------------------------------------------------------------ */

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
/* Accuracy, openings, review priority                                 */
/* ------------------------------------------------------------------ */

/** Score % (0–1) in a set of games. */
export function scoreFraction(results: MyResult[]): number | undefined {
	return results.length ? results.reduce((a, r) => a + points(r), 0) / results.length : undefined;
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

export function mean(xs: number[]): number | undefined {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

/** Accuracy edge: my accuracy − my opponent's in the same game (same site's scale). */
export function accuracyEdge(myAccuracy: number, oppAccuracy: number): number {
	return myAccuracy - oppAccuracy;
}

/** Wins on the opponent's clock. */
export function wonOnTime(result: MyResult, termination?: string): boolean {
	return result === "win" && /time/i.test(termination ?? "");
}

/** Losses from running out of time. */
export function lostOnTime(result: MyResult, termination?: string): boolean {
	return result === "loss" && /time/i.test(termination ?? "");
}

export interface PriorityInput {
	result: MyResult;
	blunders?: number;
	mistakes?: number;
	myAccuracy?: number;
	oppAccuracy?: number;
	/** I held a winning position and did not win. */
	thrownWin?: boolean;
}

/**
 * Review priority: my blunders (1 each) and mistakes (½ each), up to 2; how much less
 * accurate I was than my opponent (points ÷ 10, up to 1); +0.5 if I let a winning
 * position go; +0.5 if I lost.
 */
export function reviewPriority(o: PriorityInput): number {
	const errors = Math.min(PRIORITY_ERRORS_CAP, (o.blunders ?? 0) + 0.5 * (o.mistakes ?? 0));
	const gap =
		o.myAccuracy !== undefined && o.oppAccuracy !== undefined
			? Math.max(0, Math.min(PRIORITY_GAP_CAP, (o.oppAccuracy - o.myAccuracy) / PRIORITY_GAP_UNIT))
			: 0;
	return errors + gap + (o.thrownWin ? PRIORITY_THROWN : 0) + (o.result === "loss" ? PRIORITY_LOST : 0);
}

/* ------------------------------------------------------------------ */
/* Material (piece counting, no engine)                                */
/* ------------------------------------------------------------------ */

/** Pawn 1, knight and bishop 3, rook 5, queen 9. */
export const PIECE_VALUE = { p: 1, n: 3, r: 5, q: 9 } as const;
/** A material state counts when it holds for this many positions in a row (three moves each). */
export const LASTING_PLIES = 6;
/** Down (or up) at least this many points: a minor piece. */
export const MATERIAL_SWING = 3;
/** Endgame: at most this many pieces (not kings or pawns) left on the board, both sides together. */
export const ENDGAME_PIECES = 6;

/** Imbalances, always from my side: "rook-vs-minor" means I had the rook. */
export type Imbalance =
	| "rook-vs-minor"
	| "minor-vs-rook"
	| "rook-vs-two-minors"
	| "two-minors-vs-rook"
	| "queen-vs-pieces"
	| "pieces-vs-queen"
	| "minor-vs-pawns"
	| "pawns-vs-minor"
	| "bishop-pair"
	| "opp-bishop-pair"
	| "opposite-bishops";

export const IMBALANCE_KINDS: Imbalance[] = [
	"rook-vs-minor",
	"minor-vs-rook",
	"rook-vs-two-minors",
	"two-minors-vs-rook",
	"queen-vs-pieces",
	"pieces-vs-queen",
	"minor-vs-pawns",
	"pawns-vs-minor",
	"bishop-pair",
	"opp-bishop-pair",
	"opposite-bishops",
];

export const IMBALANCE_LABEL: Record<Imbalance, string> = {
	"rook-vs-minor": "Up the exchange",
	"minor-vs-rook": "Down the exchange",
	"rook-vs-two-minors": "Rook vs two minors",
	"two-minors-vs-rook": "Two minors vs rook",
	"queen-vs-pieces": "Queen vs pieces",
	"pieces-vs-queen": "Pieces vs queen",
	"minor-vs-pawns": "Piece vs pawns",
	"pawns-vs-minor": "Pawns vs piece",
	"bishop-pair": "Bishop pair: mine",
	"opp-bishop-pair": "Bishop pair: theirs",
	"opposite-bishops": "Opposite bishops",
};
