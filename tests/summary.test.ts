import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { computeSummary } from "../src/dashboard/summary";
import { mainline, parseGame } from "../src/pgn/tree";
import type { GameAnalysis } from "../src/engine/types";

const lichess = readFileSync(new URL("./fixtures/lichess.pgn", import.meta.url), "utf8");

/** Scripted analysis: equal until White's 6. O-O?? (ply 11), then −2.1 for White. */
function analysis(pgn: string, drop = 11): GameAnalysis {
	const plies = mainline(parseGame(pgn));
	return {
		key: "k",
		engine: "stockfish-18-lite@1.5s",
		createdAt: "",
		plies: plies.map((p, i) => ({ ply: i, fen: p.fen, score: { cp: i < drop ? 20 : -210 }, best: "a2a3", pv: [], depth: 18, source: "local" as const })),
	};
}

describe("game summary", () => {
	it("counts moves by phase, marks the blunder, and reads clocks", () => {
		const s = computeSummary({ pgn: lichess, analysis: analysis(lichess), myColour: "white", myResult: "loss", termination: "resignation", daily: false });
		expect(s.myMoves).toBe(7);
		expect(s.myMovesByPhase).toEqual({ opening: 7, middlegame: 0, endgame: 0 });
		expect(s.oppMovesByPhase.opening).toBe(6);
		const mine = s.marks.filter((m) => m.side === "me");
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ ply: 11, kind: "blunder", phase: "opening", clockSec: 482, underPressure: false, evalBeforeCp: 20, evalAfterCp: -210 });
		expect(s.biggestSwing?.ply).toBe(11);
		expect(s.myPeakEvalCp).toBe(20);
		expect(s.myLowEvalCp).toBe(-210);
		expect(s.myEvalAfterMove15Cp).toBeNull(); // game ends before move 15
		expect(s.reachedLosing).toBe(true);
		expect(s.reachedWinning).toBe(false);
		expect(s.hasClocks).toBe(true);
		expect(s.timeTrouble).toBe(false);
		expect(s.lostOnTime).toBe(false);
		expect(s.myMovesUnderPressure).toBe(0);
		expect(s.secondsOnFirst10Moves).toBeNull(); // fewer than 10 moves of mine
	});
	it("is from the other side's view for Black", () => {
		const s = computeSummary({ pgn: lichess, analysis: analysis(lichess), myColour: "black", myResult: "win", daily: false });
		expect(s.myMoves).toBe(6);
		expect(s.marks.filter((m) => m.side === "opp")).toHaveLength(1);
		expect(s.myPeakEvalCp).toBe(210);
		// Only one Black move (6...Bxc2) follows the drop: winning needs two consecutive moves.
		expect(s.reachedWinning).toBe(false);
	});
	it("detects the endgame by material", () => {
		const pgn = `[Result "1/2-1/2"]\n\n1. e4 e5 2. Qh5 Qh4 3. Qxh4 Bb4 4. Qxd8+ Kxd8 5. Nc3 Bxc3 6. dxc3 Nc6 1/2-1/2`;
		const s = computeSummary({ pgn, analysis: analysis(pgn, 99), myColour: "white", myResult: "draw", daily: false });
		// After 3. Qxh4 (ply 5) material is 31+22 = 53; queens off at ply 8 → 22+22 = 44, still middlegame-free opening;
		// after 5...Bxc3 6. dxc3 (ply 11) White 19, Black 19 → 38. Not an endgame yet.
		expect(s.myMovesByPhase.endgame).toBe(0);
		expect(s.hasClocks).toBe(false);
		expect(s.timeTrouble).toBeNull();
	});
});
