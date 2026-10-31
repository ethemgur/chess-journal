export type Site = "lichess" | "otb";
export type Colour = "white" | "black";
export type Result = "1-0" | "0-1" | "1/2-1/2";
export type MyResult = "win" | "loss" | "draw";
export type TimeClass = "bullet" | "blitz" | "rapid" | "classical" | "daily";

export const TIME_CLASSES: TimeClass[] = ["bullet", "blitz", "rapid", "classical", "daily"];

/** Every source is converted into one GameRecord before anything touches the vault. */
export interface GameRecord {
	key: string; // "lichess:abcd1234" | "otb:<sha1>"
	site: Site;
	url?: string;
	playedAt: string; // ISO 8601, UTC, game start
	white: { name: string; rating?: number };
	black: { name: string; rating?: number };
	myColour: Colour;
	result: Result;
	myResult: MyResult;
	termination?: string;
	timeControl?: string;
	timeClass?: TimeClass;
	rated?: boolean;
	eco?: string;
	opening?: string;
	event?: string;
	round?: string;
	sourceAccuracy?: { white?: number; black?: number };
	/** From the PGN's clock times (no engine): my time trouble and time on my first 10 moves. */
	clock?: ClockStats;
	/** From the PGN's moves (piece counting, no engine). */
	position?: PositionStats;
	/**
	 * Lichess games only: Lichess's own computer analysis, or "awaiting" while the game
	 * has not been analysed on lichess.org yet. Undefined for OTB games (analysed on device).
	 */
	siteAnalysis?: SiteAnalysis | "awaiting";
	/** From the analysis (Lichess's): where my mistakes happened, missed chances, best and worst position. */
	errors?: ErrorStats;
	pgn: string;
}

/** Per-game mistake statistics (mistake = Lichess "Mistake" or "Blunder"), from my side. */
export interface ErrorStats {
	/** My mistakes in each phase; undefined without a phase division (OTB games). */
	phases?: { opening: number; middlegame: number; endgame: number };
	/** My mistakes made with my clock in time trouble; undefined without clocks. */
	lowClock?: number;
	/** Opponent's mistakes I did not punish (my reply gave most of it back). */
	missed: number;
	/** Opponent's mistakes. */
	oppErrors: number;
	/** My move number of my first mistake; undefined when I made none. */
	firstError?: number;
	/** Best and worst evaluation I held for a few moves, in pawns from my side (±10 cap). */
	evalHigh: number;
	evalLow: number;
}

export interface SideAnalysis {
	inaccuracies: number;
	mistakes: number;
	blunders: number;
	acpl?: number;
	accuracy?: number;
}

/** A computer analysis made by the site (Lichess), as the site reported it. */
export interface SiteAnalysis {
	white: SideAnalysis;
	black: SideAnalysis;
	/** One entry per main-line move: evaluation after the move (White's view), and Lichess's judgement of it. */
	moves: Array<{ cp?: number; mate?: number; best?: string; variation?: string; judgment?: "Inaccuracy" | "Mistake" | "Blunder"; comment?: string }>;
}

/** "awaiting": a Lichess game that has not been analysed on lichess.org yet. */
export type AnalysisStatus = "none" | "awaiting" | "queued" | "running" | "done" | "failed";


export interface ClockStats {
	timeTrouble: boolean | null;
	first10Seconds: number | null;
	oppTimeTrouble: boolean | null;
	/** Clock left after moves 10, 20, 30, 40 (as far as the game went), % of base time. */
	clockCurve: number[];
	oppClockCurve: number[];
	/** My longest think in seconds, and on which of my moves. */
	longestThink: number | null;
	longestThinkMove: number | null;
}

export interface PositionStats {
	moves: number;
	/** My lowest and highest lasting material balance (pawn = 1 … queen = 9). */
	materialLow: number;
	materialHigh: number;
	/** Material balance in the final position. */
	materialEnd: number;
	/** Lasting imbalances, from my side (see IMBALANCE_KINDS). */
	imbalances: string[];
	/** An endgame was reached (ENDGAME_PIECES or fewer pieces left). */
	endgame: boolean;
}
