import { ACPL_LOSS_CLAMP, MATE_CP, THRESHOLDS, WIN_CHANCE_CLAMP_CP, WIN_CHANCE_K } from "./constants";
import type { Colour } from "../types";
import type { PlyAnalysis, Score } from "./types";

export type Mark = "inaccuracy" | "mistake" | "blunder";
export const MARK_RANK: Record<Mark, number> = { inaccuracy: 1, mistake: 2, blunder: 3 };

/** Centipawns from White's point of view; mate counts as ±10 000. */
export function scoreToCp(s: Score): number {
	if (s.mate !== undefined) return s.mate > 0 ? MATE_CP : s.mate < 0 ? -MATE_CP : 0;
	return s.cp ?? 0;
}

/** W(cp) = 2 / (1 + e^(-k·cp)) − 1, with cp clamped to ±1000. Runs from −1 to +1. */
export function winningChances(cp: number): number {
	const c = Math.max(-WIN_CHANCE_CLAMP_CP, Math.min(WIN_CHANCE_CLAMP_CP, cp));
	return 2 / (1 + Math.exp(-WIN_CHANCE_K * c)) - 1;
}

const sign = (mover: Colour) => (mover === "white" ? 1 : -1);

export interface MoveJudgement {
	delta: number; // drop in winning chances for the mover
	cpLoss: number; // clamped 0..1000
	mark?: Mark;
}

/**
 * Judge one move. `before` is the evaluation of the position before the move
 * (i.e. with the engine's best move), `after` the evaluation after the played
 * move. Both from White's point of view.
 */
export function judgeMove(before: Score, after: Score, mover: Colour, played: string, best?: string): MoveJudgement {
	const s = sign(mover);
	const wBefore = winningChances(s * scoreToCp(before));
	const wAfter = winningChances(s * scoreToCp(after));
	const delta = wBefore - wAfter;
	const cpLoss = Math.max(0, Math.min(ACPL_LOSS_CLAMP, s * scoreToCp(before) - s * scoreToCp(after)));
	if (best && played === best) return { delta, cpLoss: 0 };
	let mark: Mark | undefined;
	if (delta >= THRESHOLDS.blunder) mark = "blunder";
	else if (delta >= THRESHOLDS.mistake) mark = "mistake";
	else if (delta >= THRESHOLDS.inaccuracy) mark = "inaccuracy";
	// Turning a forced mate for you into a non-mate is at least a mistake.
	const hadMate = before.mate !== undefined && s * before.mate > 0;
	const stillMate = after.mate !== undefined && s * after.mate > 0;
	if (hadMate && !stillMate && (!mark || MARK_RANK[mark] < MARK_RANK.mistake)) mark = "mistake";
	return { delta, cpLoss, mark };
}

export interface MarkCounts {
	inaccuracies: number;
	mistakes: number;
	blunders: number;
}

export interface GameMarks {
	/** Mark per main-line ply index (1 = first move). */
	marks: Map<number, Mark>;
	white: MarkCounts & { acpl?: number };
	black: MarkCounts & { acpl?: number };
}

/**
 * Classify every main-line move. `plies[i]` is the analysis of the position
 * after i moves; `moves[i]` is the UCI of the move from ply i to i+1;
 * `startTurn` is the side to move at ply 0.
 */
export function classifyGame(plies: PlyAnalysis[], moves: string[], startTurn: Colour = "white"): GameMarks {
	const marks = new Map<number, Mark>();
	const counts = {
		white: { inaccuracies: 0, mistakes: 0, blunders: 0, loss: 0, n: 0 },
		black: { inaccuracies: 0, mistakes: 0, blunders: 0, loss: 0, n: 0 },
	};
	const byPly = new Map(plies.map((p) => [p.ply, p]));
	for (let i = 0; i < moves.length; i++) {
		const before = byPly.get(i);
		const after = byPly.get(i + 1);
		if (!before || !after) continue;
		const mover: Colour = (i % 2 === 0) === (startTurn === "white") ? "white" : "black";
		const j = judgeMove(before.score, after.score, mover, moves[i], before.best);
		const c = counts[mover];
		c.loss += j.cpLoss;
		c.n++;
		if (j.mark) {
			marks.set(i + 1, j.mark);
			if (j.mark === "inaccuracy") c.inaccuracies++;
			else if (j.mark === "mistake") c.mistakes++;
			else c.blunders++;
		}
	}
	const out = (c: typeof counts.white) => ({
		inaccuracies: c.inaccuracies,
		mistakes: c.mistakes,
		blunders: c.blunders,
		acpl: c.n ? Math.round(c.loss / c.n) : undefined,
	});
	return { marks, white: out(counts.white), black: out(counts.black) };
}
