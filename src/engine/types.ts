export interface Score {
	cp?: number;
	mate?: number;
}

export interface PlyAnalysis {
	ply: number; // 0 = start position
	fen: string;
	score: Score; // White's point of view
	best: string; // UCI
	pv: string[]; // first 8 plies, UCI
	depth: number;
	source: "local" | "cloud" | "lichess";
}

export interface GameAnalysis {
	key: string;
	engine: string;
	createdAt: string;
	plies: PlyAnalysis[];
	/** Move marks decided by the source (Lichess), by main-line ply (1 = first move). Engine analyses leave this out. */
	marks?: Record<number, "inaccuracy" | "mistake" | "blunder">;
	/** Lichess's comment on a marked move, by ply. */
	comments?: Record<number, string>;
}

export interface EngineLine {
	multipv: number;
	depth: number;
	score: Score; // White's point of view
	pv: string[];
}
