import { describe, expect, it } from "vitest";
import { errorStats } from "../src/sources/errors";
import type { Mark } from "../src/engine/classify";
import type { PlyAnalysis } from "../src/engine/types";

// White's clock after each move: 4:50, 3:20, 0:25, 0:20 (time trouble below 30 s in a 5-minute game).
const PGN = `[White "me"]
[Black "opp"]
[Result "0-1"]
[TimeControl "300+0"]

1. e4 { [%clk 0:04:50] } 1... e5 { [%clk 0:04:55] } 2. Nf3 { [%clk 0:03:20] } 2... Nc6 { [%clk 0:04:50] } 3. Bc4 { [%clk 0:00:25] } 3... Bc5 { [%clk 0:04:40] } 4. c3 { [%clk 0:00:20] } 4... Nf6 { [%clk 0:04:30] } 0-1`;

/** Evaluations (centipawns, White's view) after each ply, 0 = start. */
const plies = (cps: number[]): PlyAnalysis[] => cps.map((cp, ply) => ({ ply, fen: "", score: { cp }, best: "", pv: [], depth: 0, source: "lichess" }));

describe("mistake statistics", () => {
	const marks = new Map<number, Mark>([
		[5, "mistake"], // 3.Bc4, clock before the move 3:20
		[6, "blunder"], // 3...Bc5, the opponent's
		[7, "blunder"], // 4.c3, clock before the move 0:25: time trouble
	]);
	const evals = plies([20, 20, 20, 20, 20, -100, 300, -200, -200]);

	it("phase, time trouble, first mistake and missed chances", () => {
		const e = errorStats({ pgn: PGN, myColour: "white", plies: evals, marks, division: { middle: 4, end: 6 }, daily: false })!;
		expect(e.phases).toEqual({ opening: 0, middlegame: 1, endgame: 1 });
		expect(e.lowClock).toBe(1);
		expect(e.firstError).toBe(3);
		// 3...Bc5?? took me from −1 to +3; 4.c3?? gave it all back.
		expect(e.oppErrors).toBe(1);
		expect(e.missed).toBe(1);
	});

	it("without a division (OTB) there are no phases; daily games have no clock figure", () => {
		const e = errorStats({ pgn: PGN, myColour: "white", plies: evals, marks, daily: true })!;
		expect(e.phases).toBeUndefined();
		expect(e.lowClock).toBeUndefined();
	});

	it("a punished mistake is not missed; lasting best and worst positions", () => {
		const kept = plies([20, 20, 20, 20, 20, -100, 400, 450, 500]);
		const e = errorStats({ pgn: PGN, myColour: "white", plies: kept, marks: new Map([[6, "blunder"]]), division: {}, daily: false })!;
		expect(e.missed).toBe(0);
		expect(e.firstError).toBeUndefined();
		expect(e.phases).toEqual({ opening: 0, middlegame: 0, endgame: 0 });
		// +4, +4.5, +5 hold for only three positions after −1: not four in a row.
		expect(e.evalHigh).toBe(0.2);
		const black = errorStats({ pgn: PGN, myColour: "black", plies: kept, marks: new Map(), daily: false })!;
		expect(black.evalHigh).toBe(0);
		expect(black.evalLow).toBe(-0.2);
	});
});
