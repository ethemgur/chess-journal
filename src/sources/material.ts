/**
 * Move and material statistics read from a PGN's main line: piece counting only,
 * no engine. Used for comebacks, imbalances and endgames on the dashboard.
 */
import type { Position } from "chessops/chess";
import { SquareSet } from "chessops/squareSet";
import type { Color } from "chessops/types";
import type { Colour, PositionStats } from "../types";
import { mainline, parseGame } from "../pgn/tree";
import { ENDGAME_PIECES, IMBALANCE_KINDS, Imbalance, LASTING_PLIES, PIECE_VALUE } from "../dashboard/definitions";

interface Counts {
	p: number;
	n: number;
	b: number;
	lightB: number;
	r: number;
	q: number;
}

function counts(pos: Position, c: Color): Counts {
	const b = pos.board.pieces(c, "bishop");
	return {
		p: pos.board.pieces(c, "pawn").size(),
		n: pos.board.pieces(c, "knight").size(),
		b: b.size(),
		lightB: b.intersect(SquareSet.lightSquares()).size(),
		r: pos.board.pieces(c, "rook").size(),
		q: pos.board.pieces(c, "queen").size(),
	};
}

const value = (c: Counts) => c.p * PIECE_VALUE.p + (c.n + c.b) * PIECE_VALUE.n + c.r * PIECE_VALUE.r + c.q * PIECE_VALUE.q;
const bishopPair = (c: Counts) => c.lightB >= 1 && c.b - c.lightB >= 1;

/** Imbalances in one position, from my side ("mine vs theirs"). */
export function imbalancesOf(me: Counts, opp: Counts): Imbalance[] {
	const out: Imbalance[] = [];
	const dQ = me.q - opp.q;
	const dR = me.r - opp.r;
	const dM = me.n + me.b - (opp.n + opp.b);
	const dP = me.p - opp.p;
	if (dQ > 0 && (dR < 0 || dM < 0)) out.push("queen-vs-pieces");
	else if (dQ < 0 && (dR > 0 || dM > 0)) out.push("pieces-vs-queen");
	else if (dQ === 0) {
		if (dR > 0 && dM < 0) out.push(dR === 1 && dM <= -2 ? "rook-vs-two-minors" : "rook-vs-minor");
		else if (dR < 0 && dM > 0) out.push(dR === -1 && dM >= 2 ? "two-minors-vs-rook" : "minor-vs-rook");
		else if (dR === 0 && dM > 0 && dP <= -2) out.push("minor-vs-pawns");
		else if (dR === 0 && dM < 0 && dP >= 2) out.push("pawns-vs-minor");
	}
	if (dM === 0 && bishopPair(me) && !bishopPair(opp)) out.push("bishop-pair");
	if (dM === 0 && bishopPair(opp) && !bishopPair(me)) out.push("opp-bishop-pair");
	if (me.b === 1 && opp.b === 1 && me.n === 0 && opp.n === 0 && me.lightB !== opp.lightB) out.push("opposite-bishops");
	return out;
}

/**
 * Lasting material balance and imbalances: a state counts only when it holds for
 * LASTING_PLIES positions in a row, so the middle of an exchange is not counted.
 */
export function positionStats(pgn: string, myColour: Colour): PositionStats | undefined {
	let plies;
	try {
		plies = mainline(parseGame(pgn));
	} catch {
		return undefined;
	}
	if (plies.length < 2) return undefined;
	const oppColour: Color = myColour === "white" ? "black" : "white";
	const balances: number[] = [];
	const runs = new Map<Imbalance, number>();
	const lasting = new Set<Imbalance>();
	let endgame = false;
	for (const { pos } of plies) {
		const me = counts(pos, myColour);
		const opp = counts(pos, oppColour);
		balances.push(value(me) - value(opp));
		const pieces = me.n + me.b + me.r + me.q + opp.n + opp.b + opp.r + opp.q;
		if (pieces <= ENDGAME_PIECES) endgame = true;
		const now = new Set(imbalancesOf(me, opp));
		for (const k of IMBALANCE_KINDS) {
			const run = now.has(k) ? (runs.get(k) ?? 0) + 1 : 0;
			runs.set(k, run);
			if (run >= LASTING_PLIES) lasting.add(k);
		}
	}
	let low = 0;
	let high = 0;
	for (let i = 0; i + LASTING_PLIES <= balances.length; i++) {
		const w = balances.slice(i, i + LASTING_PLIES);
		low = Math.min(low, Math.max(...w));
		high = Math.max(high, Math.min(...w));
	}
	return {
		moves: Math.ceil((plies.length - 1) / 2),
		materialLow: low,
		materialHigh: high,
		imbalances: IMBALANCE_KINDS.filter((k) => lasting.has(k)),
		endgame,
	};
}
