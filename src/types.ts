export type Site = "lichess" | "chesscom" | "otb";
export type Colour = "white" | "black";
export type Result = "1-0" | "0-1" | "1/2-1/2";
export type MyResult = "win" | "loss" | "draw";
export type TimeClass = "bullet" | "blitz" | "rapid" | "classical" | "daily";

export const TIME_CLASSES: TimeClass[] = ["bullet", "blitz", "rapid", "classical", "daily"];

/** Every source is converted into one GameRecord before anything touches the vault. */
export interface GameRecord {
	key: string; // "lichess:abcd1234" | "chesscom:<uuid>" | "otb:<sha1>"
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
	pgn: string;
}

export type AnalysisStatus = "none" | "queued" | "running" | "done" | "failed";


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
