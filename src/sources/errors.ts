/**
 * Per-game mistake statistics from a computer analysis (Lichess's, or Stockfish's
 * for OTB games): where my mistakes happened (game phase, clock), which of my
 * opponent's mistakes I did not punish, my first mistake, and how good or bad my
 * position got. Stored in the note's frontmatter so the dashboard can aggregate them.
 */
import type { Colour, ErrorStats } from "../types";
import type { PlyAnalysis } from "../engine/types";
import type { Mark } from "../engine/classify";
import { scoreToCp, winningChances } from "../engine/classify";
import { commentOf, mainline, parseGame, parseTimeControl } from "../pgn/tree";
import { EVAL_CAP, EVAL_LASTING_PLIES, MISSED_GIVE_BACK, timeTroubleThreshold } from "../dashboard/definitions";

/** Plies where the middlegame and the endgame begin (Lichess's "division"). */
export interface Division {
	middle?: number;
	end?: number;
}

export interface ErrorInput {
	pgn: string;
	myColour: Colour;
	/** Evaluation of every main-line position, by ply (0 = start). */
	plies: PlyAnalysis[];
	/** Marked moves by ply (1 = first move). */
	marks: Map<number, Mark>;
	division?: Division;
	daily: boolean;
}

const isError = (m?: Mark) => m === "mistake" || m === "blunder";

/** Evaluation in pawns from my side, capped at ±EVAL_CAP (mate counts as the cap). */
function myPawns(p: PlyAnalysis | undefined, me: Colour): number | undefined {
	if (!p) return undefined;
	const cp = scoreToCp(p.score) * (me === "white" ? 1 : -1);
	return Math.max(-EVAL_CAP, Math.min(EVAL_CAP, cp / 100));
}

/** My winning chances (−1…+1) at a ply. */
function myChances(p: PlyAnalysis | undefined, me: Colour): number | undefined {
	return p ? winningChances(scoreToCp(p.score) * (me === "white" ? 1 : -1)) : undefined;
}

export function errorStats(o: ErrorInput): ErrorStats | undefined {
	let game;
	try {
		game = parseGame(o.pgn);
	} catch {
		return undefined;
	}
	const line = mainline(game);
	if (line.length < 2) return undefined;
	const byPly = new Map(o.plies.map((p) => [p.ply, p]));
	const startWhite = line[0].pos.turn === "white";
	/** Whether the move to ply i (1-based) was mine. */
	const mine = (i: number) => (((i - 1) % 2 === 0) === startWhite) === (o.myColour === "white");
	const me = o.myColour;

	// Phase of the move to ply i, by Lichess's division (absent: the game never reached that phase).
	const phaseOf = (i: number): "opening" | "middlegame" | "endgame" => {
		const d = o.division;
		if (d?.end !== undefined && i > d.end) return "endgame";
		if (d?.middle !== undefined && i > d.middle) return "middlegame";
		return "opening";
	};

	// My clock before each of my moves: the clock after my previous move (base time before the first).
	const tc = parseTimeControl(game.headers.get("TimeControl"));
	const useClock = !o.daily && !!tc?.base;
	const threshold = useClock && tc ? timeTroubleThreshold(tc.base) : 0;
	let myClock: number | undefined = useClock ? tc?.base : undefined;
	let clocksSeen = false;

	const phases = { opening: 0, middlegame: 0, endgame: 0 };
	let lowClock = 0;
	let missed = 0;
	let oppErrors = 0;
	let firstError: number | undefined;
	let myMoveNo = 0;

	for (let i = 1; i < line.length; i++) {
		const mark = o.marks.get(i);
		const node = line[i].node;
		const clockAfter = node ? commentOf(node, game).clock : undefined;
		if (mine(i)) {
			myMoveNo++;
			if (isError(mark)) {
				phases[phaseOf(i)]++;
				if (firstError === undefined) firstError = myMoveNo;
				if (useClock && myClock !== undefined && myClock < threshold) lowClock++;
			}
			if (clockAfter !== undefined) {
				myClock = clockAfter;
				clocksSeen = true;
			}
		} else if (isError(mark)) {
			oppErrors++;
			// Missed: my reply gave back at least MISSED_GIVE_BACK of what their mistake gave me.
			const before = myChances(byPly.get(i - 1), me);
			const after = myChances(byPly.get(i), me);
			const reply = myChances(byPly.get(i + 1), me);
			if (before !== undefined && after !== undefined && reply !== undefined && i + 1 < line.length) {
				const gain = after - before;
				if (gain > 0 && after - reply >= MISSED_GIVE_BACK * gain) missed++;
			}
		}
	}

	// Best and worst position I held for EVAL_LASTING_PLIES positions in a row.
	const evals = line.map((_, i) => myPawns(byPly.get(i), me)).filter((v): v is number => v !== undefined);
	let high = 0;
	let low = 0;
	for (let i = 0; i + EVAL_LASTING_PLIES <= evals.length; i++) {
		const w = evals.slice(i, i + EVAL_LASTING_PLIES);
		high = Math.max(high, Math.min(...w));
		low = Math.min(low, Math.max(...w));
	}
	const round1 = (v: number) => Math.round(v * 10) / 10;

	return {
		phases: o.division ? phases : undefined,
		lowClock: useClock && clocksSeen ? lowClock : undefined,
		missed,
		oppErrors,
		firstError,
		evalHigh: round1(high),
		evalLow: round1(low),
	};
}
