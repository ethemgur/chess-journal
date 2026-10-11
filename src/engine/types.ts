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
	source: "local" | "cloud";
}

export interface GameAnalysis {
	key: string;
	engine: string;
	createdAt: string;
	plies: PlyAnalysis[];
}

export interface EngineLine {
	multipv: number;
	depth: number;
	score: Score; // White's point of view
	pv: string[];
}
