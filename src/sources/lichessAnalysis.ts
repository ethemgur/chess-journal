/**
 * Turn Lichess's computer analysis (the export's "analysis" array) into the
 * GameAnalysis the board shows: an evaluation for every main-line position,
 * Lichess's best move and line where it judged the played move inaccurate,
 * and Lichess's own move marks. No engine involved.
 */
import { parseSan } from "chessops/san";
import type { Position } from "chessops/chess";
import type { SiteAnalysis } from "../types";
import type { GameAnalysis, PlyAnalysis, Score } from "../engine/types";
import { MATE_CP } from "../engine/constants";
import { mainline, parseGame, standardUci } from "../pgn/tree";

export const LICHESS_ENGINE_LABEL = "lichess";

const MARK: Record<string, "inaccuracy" | "mistake" | "blunder"> = { Inaccuracy: "inaccuracy", Mistake: "mistake", Blunder: "blunder" };

/** SAN line from a position -> UCI moves (stops at the first move that does not parse). */
function sanLineToUci(start: Position, line: string, max = 8): string[] {
	const pos = start.clone();
	const out: string[] = [];
	for (const san of line.split(/\s+/).filter(Boolean)) {
		if (out.length >= max) break;
		const move = parseSan(pos, san);
		if (!move) break;
		out.push(standardUci(pos, move));
		pos.play(move);
	}
	return out;
}

/** Position with no legal moves: checkmate or stalemate score, White's point of view. */
function terminal(pos: Position): Score | undefined {
	if (pos.isCheckmate()) return { cp: pos.turn === "white" ? -MATE_CP : MATE_CP };
	if (pos.isStalemate() || pos.isInsufficientMaterial()) return { cp: 0 };
	return undefined;
}

/**
 * `analysis.moves[i]` is Lichess's evaluation after main-line move i+1, and its best
 * move / line is the alternative to that move (played from the position before it).
 */
export function gameAnalysisFromLichess(key: string, pgn: string, analysis: SiteAnalysis): GameAnalysis | undefined {
	let plies;
	try {
		plies = mainline(parseGame(pgn));
	} catch {
		return undefined;
	}
	if (plies.length < 2) return undefined;
	const out: PlyAnalysis[] = [];
	const marks: Record<number, "inaccuracy" | "mistake" | "blunder"> = {};
	const comments: Record<number, string> = {};
	let last: Score | undefined;
	for (let i = 1; i < plies.length; i++) {
		const m = analysis.moves[i - 1];
		let score: Score | undefined;
		if (m?.mate !== undefined) score = { mate: m.mate };
		else if (m?.cp !== undefined) score = { cp: m.cp };
		else score = terminal(plies[i].pos) ?? last;
		out.push({ ply: i, fen: plies[i].fen, score: score ?? { cp: 0 }, best: "", pv: [], depth: 0, source: "lichess" });
		last = score ?? last;
		if (m?.judgment) {
			marks[i] = MARK[m.judgment];
			if (m.comment) comments[i] = m.comment;
		}
	}
	// Lichess does not evaluate the starting position: use the first evaluation so the graph starts level with it.
	out.unshift({ ply: 0, fen: plies[0].fen, score: out[0]?.score ?? { cp: 0 }, best: "", pv: [], depth: 0, source: "lichess" });
	// Best move and line for the position before each inaccurate move.
	for (let i = 1; i < plies.length; i++) {
		const m = analysis.moves[i - 1];
		if (!m?.best && !m?.variation) continue;
		const before = out[i - 1];
		const pv = m.variation ? sanLineToUci(plies[i - 1].pos, m.variation) : [];
		before.best = pv[0] ?? m.best ?? "";
		before.pv = pv.length ? pv : m.best ? [m.best] : [];
	}
	return { key, engine: LICHESS_ENGINE_LABEL, createdAt: new Date().toISOString(), plies: out, marks, comments };
}
